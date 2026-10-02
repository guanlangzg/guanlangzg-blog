'use client';

import { useCallback, useEffect } from 'react';
import type { Category, Tool } from '@/app/types/navigation';
import defaultNavData from '@/content/seeds/navigation/data/tools.json';
import { useSyncedResource } from '@/app/hooks/useSyncedResource';
import { parseNavigationData } from '@/lib/navigation-data';
import { createEditorCsrfHeaders } from '@/app/editor/editor-csrf';

const STORAGE_KEY = 'blog-navigation-data';
const STORAGE_META_KEY = 'blog-navigation-data-meta';
const NAVIGATION_API_PATH = '/api/data/navigation';
const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

interface LocalStorageContext {
  dirty: boolean;
}

function loadNavDataFromStorage(): Category[] | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);

    if (!stored) {
      return null;
    }

    return parseNavigationData(JSON.parse(stored));
  } catch (error) {
    console.error('Failed to load navigation data from localStorage:', error);
    return null;
  }
}

function isLocalNavigationStorageDirty(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const meta = localStorage.getItem(STORAGE_META_KEY);
    const parsed = meta ? JSON.parse(meta) as { dirty?: unknown } : null;

    return parsed?.dirty === true;
  } catch {
    return false;
  }
}

function saveNavDataToStorage(data: Category[], context: LocalStorageContext): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(STORAGE_META_KEY, JSON.stringify({ dirty: context.dirty }));
  } catch (error) {
    console.error('Failed to save navigation data to localStorage:', error);
  }
}

async function loadNavDataFromServer() {
  try {
    const response = await fetch(NAVIGATION_API_PATH, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;

      return {
        error: true as const,
        message: typeof payload?.message === 'string'
          ? payload.message
          : `导航数据从服务器加载失败（HTTP ${response.status}）。`,
      };
    }

    const payload = (await response.json()) as { categories?: unknown; revision?: unknown };
    const categories = parseNavigationData(payload.categories);

    if (!categories) {
      return {
        error: true as const,
        message: '服务器返回的导航数据格式无效。',
      };
    }

    return {
      data: categories,
      revision: typeof payload.revision === 'string' ? payload.revision : null,
    };
  } catch (error) {
    console.error('Failed to load navigation data from server:', error);
    return {
      error: true as const,
      message: error instanceof Error ? error.message : '导航数据从服务器加载失败。',
    };
  }
}

async function saveNavDataToServer(
  categories: Category[],
  context: { revision: string | null }
) {
  try {
    const response = await fetch(NAVIGATION_API_PATH, {
      method: 'PUT',
      credentials: 'include',
      headers: createEditorCsrfHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ categories, revision: context.revision }),
    });

    const payload = (await response.json().catch(() => null)) as {
      categories?: unknown;
      revision?: unknown;
      message?: unknown;
    } | null;

    if (response.status === 409) {
      const categories = parseNavigationData(payload?.categories);

      if (!categories) {
        return {
          error: true as const,
          message: '服务器返回的导航冲突数据格式无效，请刷新后重试。',
        };
      }

      return {
        conflict: true as const,
        data: categories,
        revision: typeof payload?.revision === 'string' ? payload.revision : null,
      };
    }

    if (!response.ok) {
      if (response.status === 503) {
        return {
          error: true as const,
          message: '服务器未配置持久化数据目录，导航只保存在当前浏览器。',
        };
      }

      const message = typeof payload?.message === 'string'
        ? payload.message
        : `导航同步到服务器失败（HTTP ${response.status}）。`;

      console.error('Failed to persist navigation data to server:', response.status, message);
      return {
        error: true as const,
        message,
      };
    }

    return {
      revision: typeof payload?.revision === 'string' ? payload.revision : context.revision,
    };
  } catch (error) {
    console.error('Failed to persist navigation data to server:', error);
    return {
      error: true as const,
      message: error instanceof Error ? error.message : '导航同步到服务器失败。',
    };
  }
}

function flushNavDataToServer(
  categories: Category[],
  context: { revision: string | null }
): void {
  const body = JSON.stringify({ categories, revision: context.revision });

  if (new TextEncoder().encode(body).byteLength > KEEPALIVE_BODY_LIMIT_BYTES) {
    console.warn('Skipped navigation keepalive flush because the payload is too large.');
    return;
  }

  void fetch(NAVIGATION_API_PATH, {
    method: 'PUT',
    credentials: 'include',
    keepalive: true,
    headers: createEditorCsrfHeaders({
      'Content-Type': 'application/json',
    }),
    body,
  }).catch((error: unknown) => {
    console.error('Failed to flush navigation before unload:', error);
  });
}

export function useNavigationData() {
  const { data, setData, isLoaded, lastConflictAt, lastRemoteLoadError, lastRemoteSaveError } = useSyncedResource<Category[]>({
    initialValue: () => parseNavigationData(defaultNavData) ?? [],
    loadLocal: loadNavDataFromStorage,
    saveLocal: saveNavDataToStorage,
    isLocalDirty: isLocalNavigationStorageDirty,
    loadRemote: loadNavDataFromServer,
    saveRemote: saveNavDataToServer,
    flushRemote: flushNavDataToServer,
  });

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== STORAGE_KEY || event.newValue === null) {
        return;
      }

      try {
        const parsed = parseNavigationData(JSON.parse(event.newValue));

        if (parsed) {
          setData(parsed);
        }
      } catch (error) {
        console.error('Failed to sync navigation data from localStorage event:', error);
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [setData]);

  const addCategory = useCallback((category: Omit<Category, 'tools'> & { tools?: Tool[] }): Category => {
    const newCategory: Category = {
      ...category,
      tools: category.tools || [],
    };

    setData((previous) => [...previous, newCategory]);
    return newCategory;
  }, [setData]);

  const updateCategory = useCallback((index: number, updates: Partial<Category>): Category | null => {
    let updated: Category | null = null;

    setData((previous) => {
      if (index < 0 || index >= previous.length) {
        return previous;
      }

      const next = [...previous];
      updated = { ...next[index], ...updates };
      next[index] = updated;
      return next;
    });

    return updated;
  }, [setData]);

  const deleteCategory = useCallback((index: number): boolean => {
    let success = false;

    setData((previous) => {
      if (index < 0 || index >= previous.length) {
        return previous;
      }

      success = true;
      return previous.filter((_, currentIndex) => currentIndex !== index);
    });

    return success;
  }, [setData]);

  const addTool = useCallback((categoryIndex: number, tool: Tool): Tool | null => {
    let added: Tool | null = null;

    setData((previous) => {
      if (categoryIndex < 0 || categoryIndex >= previous.length) {
        return previous;
      }

      const next = [...previous];
      added = tool;
      next[categoryIndex] = {
        ...next[categoryIndex],
        tools: [...next[categoryIndex].tools, tool],
      };
      return next;
    });

    return added;
  }, [setData]);

  const updateTool = useCallback(
    (categoryIndex: number, toolIndex: number, updates: Partial<Tool>): Tool | null => {
      let updated: Tool | null = null;

      setData((previous) => {
        if (
          categoryIndex < 0 ||
          categoryIndex >= previous.length ||
          toolIndex < 0 ||
          toolIndex >= previous[categoryIndex].tools.length
        ) {
          return previous;
        }

        const next = [...previous];
        const nextTools = [...next[categoryIndex].tools];
        updated = { ...nextTools[toolIndex], ...updates };
        nextTools[toolIndex] = updated;
        next[categoryIndex] = {
          ...next[categoryIndex],
          tools: nextTools,
        };
        return next;
      });

      return updated;
    },
    [setData]
  );

  const deleteTool = useCallback((categoryIndex: number, toolIndex: number): boolean => {
    let success = false;

    setData((previous) => {
      if (
        categoryIndex < 0 ||
        categoryIndex >= previous.length ||
        toolIndex < 0 ||
        toolIndex >= previous[categoryIndex].tools.length
      ) {
        return previous;
      }

      success = true;
      const next = [...previous];
      next[categoryIndex] = {
        ...next[categoryIndex],
        tools: next[categoryIndex].tools.filter((_, currentIndex) => currentIndex !== toolIndex),
      };
      return next;
    });

    return success;
  }, [setData]);

  const exportData = useCallback((): string => JSON.stringify(data, null, 2), [data]);

  const importData = useCallback((json: string): boolean => {
    try {
      const parsed = parseNavigationData(JSON.parse(json));

      if (!parsed) {
        return false;
      }

      setData(parsed);
      return true;
    } catch (error) {
      console.error('Failed to import navigation data:', error);
      return false;
    }
  }, [setData]);

  const resetToDefault = useCallback((): void => {
    setData(parseNavigationData(defaultNavData) ?? []);
  }, [setData]);

  return {
    data,
    isLoaded,
    lastConflictAt,
    lastRemoteLoadError,
    lastRemoteSaveError,
    addCategory,
    updateCategory,
    deleteCategory,
    addTool,
    updateTool,
    deleteTool,
    exportData,
    importData,
    resetToDefault,
  };
}
