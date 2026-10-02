'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

interface RemoteResource<T> {
  data: T;
  revision: string | null;
}

interface RemoteLoadError {
  error: true;
  message: string;
}

interface SaveRemoteContext<T> {
  revision: string | null;
  previousValue?: T;
}

interface SaveLocalContext {
  dirty: boolean;
}

type SaveRemoteResult<T> =
  | void
  | {
    revision?: string | null;
    conflict?: false;
  }
  | {
    error: true;
    message: string;
  }
  | {
    conflict: true;
    data: T;
    revision: string | null;
  };

interface UseSyncedResourceOptions<T> {
  initialValue: T | (() => T);
  loadLocal: () => T | null;
  saveLocal: (value: T, context: SaveLocalContext) => void;
  isLocalDirty?: () => boolean;
  loadRemote: () => Promise<T | RemoteResource<T> | RemoteLoadError | null>;
  saveRemote: (value: T, context: SaveRemoteContext<T>) => Promise<SaveRemoteResult<T>>;
  flushRemote?: (value: T, context: SaveRemoteContext<T>) => void;
  saveDelayMs?: number;
}

interface SyncedResourceState<T> {
  data: T;
  setData: Dispatch<SetStateAction<T>>;
  isLoaded: boolean;
  lastConflictAt: number | null;
  lastRemoteSaveError: {
    at: number;
    message: string;
  } | null;
  lastRemoteLoadError: {
    at: number;
    message: string;
  } | null;
}

function parseRemoteValue<T>(value: T | RemoteResource<T>): RemoteResource<T> {
  if (
    value &&
    typeof value === 'object' &&
    'data' in value &&
    'revision' in value
  ) {
    return value as RemoteResource<T>;
  }

  return {
    data: value as T,
    revision: null,
  };
}

function isRemoteLoadError(value: unknown): value is RemoteLoadError {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'error' in value &&
    (value as RemoteLoadError).error === true &&
    typeof (value as RemoteLoadError).message === 'string'
  );
}

export function useSyncedResource<T>({
  initialValue,
  loadLocal,
  saveLocal,
  isLocalDirty,
  loadRemote,
  saveRemote,
  flushRemote,
  saveDelayMs = 300,
}: UseSyncedResourceOptions<T>): SyncedResourceState<T> {
  const [data, setStateData] = useState<T>(initialValue);
  const dataRef = useRef(data);
  const initialDataRef = useRef(data);
  const [isLoaded, setIsLoaded] = useState(false);
  const [lastConflictAt, setLastConflictAt] = useState<number | null>(null);
  const [lastRemoteSaveError, setLastRemoteSaveError] = useState<{
    at: number;
    message: string;
  } | null>(null);
  const [lastRemoteLoadError, setLastRemoteLoadError] = useState<{
    at: number;
    message: string;
  } | null>(null);
  const revisionRef = useRef<string | null>(null);
  const skippedRemoteSaveValueRef = useRef<{ value: T } | null>(null);
  const dataGenerationRef = useRef(0);
  const remoteSyncedGenerationRef = useRef(0);
  const saveSequenceRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const saveLocalTimerRef = useRef<number | null>(null);
  const queuedSaveRef = useRef<{ value: T; generation: number; previousValue: T } | null>(null);
  const inFlightSaveRef = useRef<{ sequence: number; generation: number } | null>(null);
  const lastRemoteValueRef = useRef<T>(data);
  const mountedRef = useRef(true);
  const isLoadedRef = useRef(false);
  const handlersRef = useRef({
    loadLocal,
    saveLocal,
    isLocalDirty,
    loadRemote,
    saveRemote,
    flushRemote,
  });

  const setData = useCallback<Dispatch<SetStateAction<T>>>((value) => {
    const previous = dataRef.current;
    const next = typeof value === 'function'
      ? (value as (previous: T) => T)(previous)
      : value;

    if (Object.is(previous, next)) {
      return;
    }

    dataGenerationRef.current += 1;
    dataRef.current = next;
    setStateData(next);
  }, []);

  const clearPendingSaveTimer = useCallback(() => {
    if (saveTimerRef.current === null) {
      return;
    }

    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  const clearLocalSaveTimer = useCallback(() => {
    if (saveLocalTimerRef.current === null) {
      return;
    }

    window.clearTimeout(saveLocalTimerRef.current);
    saveLocalTimerRef.current = null;
  }, []);

  const flushRemoteSaveQueue = useCallback(() => {
    if (inFlightSaveRef.current || !queuedSaveRef.current) {
      return;
    }

    const saveRequest = queuedSaveRef.current;
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    queuedSaveRef.current = null;
    inFlightSaveRef.current = {
      sequence,
      generation: saveRequest.generation,
    };

    const handlers = handlersRef.current;

    void handlers.saveRemote(saveRequest.value, {
      revision: revisionRef.current,
      previousValue: saveRequest.previousValue,
    }).then((result) => {
      if (!mountedRef.current || inFlightSaveRef.current?.sequence !== sequence) {
        return;
      }

      if (!result) {
        if (dataGenerationRef.current === saveRequest.generation) {
          remoteSyncedGenerationRef.current = saveRequest.generation;
          setLastRemoteSaveError(null);
        }
        return;
      }

      if ('error' in result && result.error) {
        if (dataGenerationRef.current === saveRequest.generation && !queuedSaveRef.current) {
          setLastRemoteSaveError({
            at: Date.now(),
            message: result.message,
          });
        }
        return;
      }

      if ('conflict' in result && result.conflict) {
        revisionRef.current = result.revision;
        lastRemoteValueRef.current = result.data;
        if (queuedSaveRef.current) {
          queuedSaveRef.current.previousValue = result.data;
        }

        if (dataGenerationRef.current === saveRequest.generation && !queuedSaveRef.current) {
          remoteSyncedGenerationRef.current = saveRequest.generation;
          skippedRemoteSaveValueRef.current = { value: result.data };
          dataRef.current = result.data;
          setStateData(result.data);
          setLastConflictAt(Date.now());
          handlersRef.current.saveLocal(result.data, { dirty: false });
        }
        return;
      }

      if ('revision' in result) {
        revisionRef.current = result.revision ?? null;
      }
      lastRemoteValueRef.current = saveRequest.value;

      if (dataGenerationRef.current === saveRequest.generation) {
        remoteSyncedGenerationRef.current = saveRequest.generation;
        handlersRef.current.saveLocal(saveRequest.value, { dirty: false });
        setLastRemoteSaveError(null);
      }
    }).catch((error: unknown) => {
      if (!mountedRef.current || inFlightSaveRef.current?.sequence !== sequence) {
        return;
      }

      if (dataGenerationRef.current === saveRequest.generation && !queuedSaveRef.current) {
        setLastRemoteSaveError({
          at: Date.now(),
          message: error instanceof Error ? error.message : '远端保存失败。',
        });
      }
    }).finally(() => {
      if (inFlightSaveRef.current?.sequence === sequence) {
        inFlightSaveRef.current = null;
      }

      if (!mountedRef.current) {
        return;
      }

      if (queuedSaveRef.current && saveTimerRef.current === null) {
        flushRemoteSaveQueue();
      }
    });
  }, []);

  const queueRemoteSave = useCallback((value: T, generation: number, delayMs: number) => {
    queuedSaveRef.current = {
      value,
      generation,
      previousValue: lastRemoteValueRef.current,
    };
    clearPendingSaveTimer();

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      flushRemoteSaveQueue();
    }, delayMs);
  }, [clearPendingSaveTimer, flushRemoteSaveQueue]);

  useEffect(() => {
    handlersRef.current = {
      loadLocal,
      saveLocal,
      isLocalDirty,
      loadRemote,
      saveRemote,
      flushRemote,
    };
  }, [flushRemote, isLocalDirty, loadLocal, loadRemote, saveLocal, saveRemote]);

  const flushPendingBeforeUnload = useCallback(() => {
    if (!isLoadedRef.current) {
      return;
    }

    clearLocalSaveTimer();
    clearPendingSaveTimer();

    const handlers = handlersRef.current;
    handlers.saveLocal(dataRef.current, {
      dirty: Boolean(inFlightSaveRef.current || queuedSaveRef.current),
    });

    if (inFlightSaveRef.current || !queuedSaveRef.current) {
      return;
    }

    const saveRequest = queuedSaveRef.current;

    if (handlers.flushRemote) {
      queuedSaveRef.current = null;
      handlers.flushRemote(saveRequest.value, { revision: revisionRef.current });
      return;
    }

    flushRemoteSaveQueue();
  }, [clearLocalSaveTimer, clearPendingSaveTimer, flushRemoteSaveQueue]);

  useEffect(() => {
    mountedRef.current = true;
    window.addEventListener('beforeunload', flushPendingBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', flushPendingBeforeUnload);
      mountedRef.current = false;
      clearPendingSaveTimer();
      clearLocalSaveTimer();
    };
  }, [clearLocalSaveTimer, clearPendingSaveTimer, flushPendingBeforeUnload]);

  useEffect(() => {
    let cancelled = false;

    async function initialize(): Promise<void> {
      const handlers = handlersRef.current;
      const remoteValue = await handlers.loadRemote().catch((error: unknown): RemoteLoadError => ({
        error: true,
        message: error instanceof Error ? error.message : '远端数据加载失败。',
      }));

      if (cancelled) {
        return;
      }

      if (isRemoteLoadError(remoteValue)) {
        setLastRemoteLoadError({
          at: Date.now(),
          message: remoteValue.message,
        });

        const localValue = handlers.loadLocal();
        skippedRemoteSaveValueRef.current = { value: localValue ?? initialDataRef.current };
        lastRemoteValueRef.current = localValue ?? initialDataRef.current;

        if (localValue !== null) {
          dataRef.current = localValue;
          setStateData(localValue);
        }
      } else if (remoteValue !== null) {
        const remoteResource = parseRemoteValue(remoteValue);
        const localValue = handlers.loadLocal();
        const useDirtyLocal = Boolean(localValue !== null && handlers.isLocalDirty?.());

        revisionRef.current = remoteResource.revision;
        lastRemoteValueRef.current = remoteResource.data;
        setLastRemoteLoadError(null);

        if (useDirtyLocal && localValue !== null) {
          dataGenerationRef.current += 1;
          dataRef.current = localValue;
          setStateData(localValue);
        } else {
          skippedRemoteSaveValueRef.current = { value: remoteResource.data };
          lastRemoteValueRef.current = remoteResource.data;
          dataRef.current = remoteResource.data;
          setStateData(remoteResource.data);
          handlers.saveLocal(remoteResource.data, { dirty: false });
        }
      } else {
        const localValue = handlers.loadLocal();

        if (localValue !== null) {
          skippedRemoteSaveValueRef.current = { value: localValue };
          lastRemoteValueRef.current = localValue;
          dataRef.current = localValue;
          setStateData(localValue);
        }
      }

      isLoadedRef.current = true;
      setIsLoaded(true);
    }

    void initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return undefined;
    }

    const generation = dataGenerationRef.current;

    if (
      skippedRemoteSaveValueRef.current &&
      Object.is(data, skippedRemoteSaveValueRef.current.value)
    ) {
      skippedRemoteSaveValueRef.current = null;
      remoteSyncedGenerationRef.current = generation;
      handlersRef.current.saveLocal(data, { dirty: false });
      return undefined;
    }

    clearLocalSaveTimer();

    saveLocalTimerRef.current = window.setTimeout(() => {
      saveLocalTimerRef.current = null;
      handlersRef.current.saveLocal(data, { dirty: true });
    }, 150);

    if (generation <= remoteSyncedGenerationRef.current) {
      return undefined;
    }

    queueRemoteSave(data, generation, saveDelayMs);

    return () => {
      clearLocalSaveTimer();
    };
  }, [clearLocalSaveTimer, data, isLoaded, queueRemoteSave, saveDelayMs]);

  return {
    data,
    setData,
    isLoaded,
    lastConflictAt,
    lastRemoteSaveError,
    lastRemoteLoadError,
  };
}
