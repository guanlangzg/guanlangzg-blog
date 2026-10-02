import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavigationData } from '@/app/hooks/useNavigationData';
import type { Category } from '@/app/types/navigation';

const fetchMock = vi.fn();

const remoteCategory: Category = {
  name: 'Remote Tools',
  icon: 'folder',
  slug: 'remote-tools',
  tools: [
    {
      icon: 'link',
      title: 'Remote Tool',
      description: 'Remote description',
      url: 'https://example.com/remote',
      tags: ['remote'],
    },
  ],
};

const localCategory: Category = {
  name: 'Local Tools',
  icon: 'folder',
  slug: 'local-tools',
  tools: [
    {
      icon: 'link',
      title: 'Local Tool',
      description: 'Local description',
      url: 'https://example.com/local',
      tags: ['local'],
    },
  ],
};

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function TestNavigationData({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useNavigationData>) => void;
}) {
  const api = useNavigationData();

  onReady(api);

  return (
    <div>
      <span data-testid="categories">{api.data.map((category) => category.name).join(',')}</span>
      <span data-testid="load-error">{api.lastRemoteLoadError?.message ?? ''}</span>
      <span data-testid="save-error">{api.lastRemoteSaveError?.message ?? ''}</span>
    </div>
  );
}

describe('useNavigationData', () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentApi: ReturnType<typeof useNavigationData> | null;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    currentApi = null;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the local navigation copy when the server returns invalid navigation data', async () => {
    window.localStorage.setItem('blog-navigation-data', JSON.stringify([localCategory]));
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        categories: [{ name: 'Broken' }],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(currentApi?.data).toHaveLength(1);
    expect(currentApi?.data[0]?.name).toBe('Local Tools');
    expect(container.textContent).toContain('服务器返回的导航数据格式无效');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps local edits when a conflict response contains invalid navigation data', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          categories: [remoteCategory],
          revision: 'revision-1',
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            categories: [{ name: 'Broken' }],
            revision: 'revision-2',
          },
          { status: 409 }
        )
      );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    expect(currentApi?.data[0]?.name).toBe('Remote Tools');

    await act(async () => {
      currentApi?.updateCategory(0, { name: 'Local Edit' });
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flushPromises();

    expect(currentApi?.data[0]?.name).toBe('Local Edit');
    expect(container.textContent).toContain('服务器返回的导航冲突数据格式无效');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the backend navigation save validation error instead of a generic HTTP message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          categories: [remoteCategory],
          revision: 'revision-1',
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '导航工具必须至少包含一个 tag。',
          },
          { status: 400 }
        )
      );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateTool(0, 0, { tags: [] });
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flushPromises();

    expect(container.textContent).toContain('导航工具必须至少包含一个 tag。');
    expect(container.textContent).not.toContain('导航同步到服务器失败（HTTP 400）。');
  });

  it('flushes pending navigation edits with keepalive before unload', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        categories: [remoteCategory],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateCategory(0, { name: 'Unload Tools' });
    });

    window.dispatchEvent(new Event('beforeunload'));

    expect(fetchMock).toHaveBeenLastCalledWith('/api/data/navigation', expect.objectContaining({
      keepalive: true,
      method: 'PUT',
      body: expect.stringContaining('Unload Tools'),
    }));
  });

  it('does not send oversized navigation payloads with keepalive before unload', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        categories: [remoteCategory],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateTool(0, 0, { description: 'x'.repeat(70 * 1024) });
    });

    window.dispatchEvent(new Event('beforeunload'));

    const keepaliveCalls = fetchMock.mock.calls.filter(([, init]) => (
      typeof init === 'object' &&
      init !== null &&
      'keepalive' in init &&
      init.keepalive === true
    ));

    expect(keepaliveCalls).toHaveLength(0);
    expect(window.localStorage.getItem('blog-navigation-data')).toContain('remote-tools');
    expect(window.localStorage.getItem('blog-navigation-data')).toContain('x'.repeat(70 * 1024));
    expect(window.localStorage.getItem('blog-navigation-data-meta')).toContain('true');
  });

  it('loads valid navigation updates from storage events in another tab', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        categories: [remoteCategory],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestNavigationData
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'blog-navigation-data',
        newValue: JSON.stringify([localCategory]),
        storageArea: window.localStorage,
      }));
    });

    expect(currentApi?.data).toHaveLength(1);
    expect(currentApi?.data[0]?.name).toBe('Local Tools');
  });
});
