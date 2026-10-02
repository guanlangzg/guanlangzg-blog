import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncedResource } from '@/app/hooks/useSyncedResource';

type SaveRemoteResult =
  | { revision: string | null }
  | {
    error: true;
    message: string;
  }
  | {
    conflict: true;
    data: string[];
    revision: string | null;
  };

type RemoteLoadResult =
  | { data: string[]; revision: string | null }
  | {
    error: true;
    message: string;
  }
  | string[]
  | null;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function TestSyncedResource({
  loadLocal = () => null,
  loadRemote,
  saveLocal,
  isLocalDirty,
  saveRemote,
  onReady,
}: {
  loadLocal?: () => string[] | null;
  loadRemote: () => Promise<RemoteLoadResult>;
  saveLocal: (value: string[], context: { dirty: boolean }) => void;
  isLocalDirty?: () => boolean;
  saveRemote: (value: string[], context: { revision: string | null }) => Promise<SaveRemoteResult>;
  onReady: (setData: (value: string[]) => void) => void;
}) {
  const { data, setData, lastConflictAt, lastRemoteLoadError, lastRemoteSaveError } = useSyncedResource<string[]>({
    initialValue: [],
    loadLocal,
    saveLocal,
    isLocalDirty,
    loadRemote,
    saveRemote,
    saveDelayMs: 10,
  });

  onReady(setData);

  return (
    <div>
      {data.join(',')}
      {lastConflictAt ? ' conflict-detected' : ''}
      {lastRemoteLoadError ? ` remote-load-error:${lastRemoteLoadError.message}` : ''}
      {lastRemoteSaveError ? ` remote-error:${lastRemoteSaveError.message}` : ''}
    </div>
  );
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSyncedResource', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not save remote data back immediately after initialization', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });
    const saveLocal = vi.fn();
    const onReady = vi.fn();

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={onReady}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      vi.advanceTimersByTime(20);
    });

    expect(container.textContent).toBe('remote');
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('loads local data after a remote load error without saving it back immediately', async () => {
    const loadLocal = vi.fn().mockReturnValue(['local-copy']);
    const loadRemote = vi.fn().mockResolvedValue({
      error: true,
      message: 'server unavailable',
    });
    const saveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });
    const saveLocal = vi.fn();
    const onReady = vi.fn();

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadLocal={loadLocal}
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={onReady}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      vi.advanceTimersByTime(20);
    });

    expect(container.textContent).toBe('local-copy remote-load-error:server unavailable');
    expect(loadLocal).toHaveBeenCalledOnce();
    expect(saveRemote).not.toHaveBeenCalled();
  });

  it('saves later local changes with the loaded revision', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });
    const saveLocal = vi.fn();
    let setResourceData: ((value: string[]) => void) | null = null;

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={(setData) => {
            setResourceData = setData;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(setResourceData).not.toBeNull();
    await act(async () => {
      setResourceData?.(['remote', 'local-change']);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(saveRemote).toHaveBeenCalledOnce();
    expect(saveRemote).toHaveBeenCalledWith(['remote', 'local-change'], {
      revision: 'revision-1',
      previousValue: ['remote'],
    });
  });

  it('does not save again when only save handlers change', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const firstSaveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });
    const nextSaveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-3',
    });
    const saveLocal = vi.fn();
    const onReady = vi.fn();

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={firstSaveRemote}
          onReady={onReady}
        />
      );
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={nextSaveRemote}
          onReady={onReady}
        />
      );
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(firstSaveRemote).not.toHaveBeenCalled();
    expect(nextSaveRemote).not.toHaveBeenCalled();
  });

  it('does not save conflict replacement back to remote', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi
      .fn()
      .mockResolvedValueOnce({
        conflict: true,
        data: ['server-winner'],
        revision: 'revision-2',
      })
      .mockResolvedValue({
        revision: 'revision-3',
      });
    const saveLocal = vi.fn();
    let setResourceData: ((value: string[]) => void) | null = null;

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={(setData) => {
            setResourceData = setData;
          }}
        />
      );
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(setResourceData).not.toBeNull();
    await act(async () => {
      setResourceData?.(['local-change']);
    });
    const beforeConflict = Date.now();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(container.textContent).toBe('server-winner conflict-detected');
    expect(saveRemote).toHaveBeenCalledOnce();
    expect(Date.now()).toBeGreaterThanOrEqual(beforeConflict);
  });

  it('exposes remote save errors without replacing local data', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi.fn().mockResolvedValue({
      error: true,
      message: 'server unavailable',
    });
    const saveLocal = vi.fn();
    let setResourceData: ((value: string[]) => void) | null = null;

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={(setData) => {
            setResourceData = setData;
          }}
        />
      );
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(setResourceData).not.toBeNull();
    await act(async () => {
      setResourceData?.(['local-change']);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(container.textContent).toBe('local-change remote-error:server unavailable');
    expect(saveRemote).toHaveBeenCalledOnce();
  });

  it('does not let an older conflict response replace newer local edits', async () => {
    const firstSave = createDeferred<SaveRemoteResult>();
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue({
        revision: 'revision-3',
      });
    const saveLocal = vi.fn();
    let setResourceData: ((value: string[]) => void) | null = null;

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={(setData) => {
            setResourceData = setData;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      setResourceData?.(['first-local-edit']);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(saveRemote).toHaveBeenCalledOnce();
    expect(saveRemote).toHaveBeenLastCalledWith(['first-local-edit'], {
      revision: 'revision-1',
      previousValue: ['remote'],
    });

    await act(async () => {
      setResourceData?.(['second-local-edit']);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });

    await act(async () => {
      firstSave.resolve({
        conflict: true,
        data: ['server-old-conflict'],
        revision: 'revision-2',
      });
    });
    await flushPromises();

    expect(container.textContent).toBe('second-local-edit');

    await flushPromises();

    expect(saveRemote).toHaveBeenCalledTimes(2);
    expect(saveRemote).toHaveBeenLastCalledWith(['second-local-edit'], {
      revision: 'revision-2',
      previousValue: ['server-old-conflict'],
    });
    expect(container.textContent).toBe('second-local-edit');
  });

  it('flushes pending local changes before unload', async () => {
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });
    const saveLocal = vi.fn();
    let setResourceData: ((value: string[]) => void) | null = null;

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={(setData) => {
            setResourceData = setData;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      setResourceData?.(['remote', 'local-change']);
    });

    window.dispatchEvent(new Event('beforeunload'));

    expect(saveLocal).toHaveBeenCalledWith(['remote', 'local-change'], { dirty: true });
    expect(saveRemote).toHaveBeenCalledWith(['remote', 'local-change'], {
      revision: 'revision-1',
      previousValue: ['remote'],
    });
  });

  it('keeps dirty local data over remote data and syncs it back', async () => {
    const loadLocal = vi.fn().mockReturnValue(['dirty-local']);
    const loadRemote = vi.fn().mockResolvedValue({
      data: ['remote'],
      revision: 'revision-1',
    });
    const saveLocal = vi.fn();
    const saveRemote = vi.fn().mockResolvedValue({
      revision: 'revision-2',
    });

    await act(async () => {
      root.render(
        <TestSyncedResource
          loadLocal={loadLocal}
          isLocalDirty={() => true}
          loadRemote={loadRemote}
          saveLocal={saveLocal}
          saveRemote={saveRemote}
          onReady={() => undefined}
        />
      );
    });
    await flushPromises();

    expect(container.textContent).toBe('dirty-local');

    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushPromises();

    expect(saveRemote).toHaveBeenCalledWith(['dirty-local'], {
      revision: 'revision-1',
      previousValue: ['remote'],
    });
    expect(saveLocal).toHaveBeenLastCalledWith(['dirty-local'], { dirty: false });
  });
});
