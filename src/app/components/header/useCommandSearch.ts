'use client';

import { useState, useEffect } from 'react';
import { isSearchQueryAllowed, normalizeSearchQuery } from '@/lib/search-query';

export interface CommandSearchResult {
  type: 'post' | 'tool';
  title: string;
  slug: string;
  href: string;
  description?: string;
  meta?: string;
  external?: boolean;
  tags?: string[];
}

const ADMIN_SHORTCUT = ':admin';

export { ADMIN_SHORTCUT };

export function useCommandSearch(query: string): {
  results: CommandSearchResult[];
  isLoading: boolean;
  errorMessage: string | null;
  isAdminShortcut: boolean;
} {
  const [results, setResults] = useState<CommandSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const normalizedQuery = normalizeSearchQuery(query);
  const isAdminShortcut = normalizedQuery === ADMIN_SHORTCUT;

  useEffect(() => {
    if (!normalizedQuery) {
      setResults([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    if (isAdminShortcut) {
      setResults([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    if (!isSearchQueryAllowed(normalizedQuery)) {
      setResults([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();

    const fetchResults = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(normalizedQuery)}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.message || '搜索服务暂时不可用');
        }

        const data = (await res.json()) as CommandSearchResult[];
        setResults(data);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        console.error('Search failed:', error);
        setErrorMessage(
          error instanceof Error ? error.message : '搜索服务暂时不可用'
        );
        setResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    const debounce = setTimeout(fetchResults, 300);
    return () => {
      controller.abort();
      clearTimeout(debounce);
    };
  }, [isAdminShortcut, normalizedQuery]);

  return { results, isLoading, errorMessage, isAdminShortcut };
}
