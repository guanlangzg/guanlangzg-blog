import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalArticles } from '@/app/hooks/useLocalArticles';
import type { Article } from '@/app/types/article';

const fetchMock = vi.fn();

const remoteArticle: Article = {
  id: 'remote-article',
  title: 'Remote Article',
  date: '2026-05-24',
  description: 'Remote description',
  tags: ['remote'],
  content: '# Remote',
  createdAt: 1,
  updatedAt: 1,
};

const localArticle: Article = {
  id: 'local-article',
  title: 'Local Article',
  date: '2026-05-24',
  description: 'Local description',
  tags: ['local'],
  content: '# Local',
  createdAt: 2,
  updatedAt: 2,
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

function TestLocalArticles({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useLocalArticles>) => void;
}) {
  const api = useLocalArticles();

  onReady(api);

  return (
    <div>
      <span data-testid="titles">{api.articles.map((article) => article.title).join(',')}</span>
      <span data-testid="load-error">{api.lastRemoteLoadError?.message ?? ''}</span>
      <span data-testid="save-error">{api.lastRemoteSaveError?.message ?? ''}</span>
    </div>
  );
}

describe('useLocalArticles', () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentApi: ReturnType<typeof useLocalArticles> | null;

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

  it('keeps the local article copy when the server returns invalid article data', async () => {
    window.localStorage.setItem('blog-local-articles', JSON.stringify([localArticle]));
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        articles: [{ id: 'broken' }],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestLocalArticles
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

    expect(currentApi?.articles).toHaveLength(1);
    expect(currentApi?.articles[0]?.title).toBe('Local Article');
    expect(container.textContent).toContain('服务器返回的文章数据格式无效');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps local edits when a conflict response contains invalid article data', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          articles: [remoteArticle],
          revision: 'revision-1',
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            articles: [{ id: 'broken' }],
            revision: 'revision-2',
          },
          { status: 409 }
        )
      );

    await act(async () => {
      root.render(
        <TestLocalArticles
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    expect(currentApi?.articles[0]?.title).toBe('Remote Article');

    await act(async () => {
      currentApi?.updateArticle('remote-article', { title: 'Local Edit' });
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flushPromises();

    expect(currentApi?.articles[0]?.title).toBe('Local Edit');
    expect(container.textContent).toContain('服务器返回的文章冲突数据格式无效');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the backend article save validation error instead of a generic HTTP message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          articles: [remoteArticle],
          revision: 'revision-1',
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '文章 slug 重复：remote-article',
          },
          { status: 400 }
        )
      );

    await act(async () => {
      root.render(
        <TestLocalArticles
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateArticle('remote-article', { slug: 'remote-article' });
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await flushPromises();

    expect(container.textContent).toContain('文章 slug 重复：remote-article');
    expect(container.textContent).not.toContain('文章同步到服务器失败（HTTP 400）。');
  });

  it('flushes pending article edits with keepalive before unload', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        articles: [remoteArticle],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestLocalArticles
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateArticle('remote-article', { title: 'Unload Edit' });
    });

    window.dispatchEvent(new Event('beforeunload'));

    expect(fetchMock).toHaveBeenLastCalledWith('/api/data/articles', expect.objectContaining({
      keepalive: true,
      method: 'PUT',
      body: expect.stringContaining('Unload Edit'),
    }));
  });

  it('does not send oversized article payloads with keepalive before unload', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        articles: [remoteArticle],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestLocalArticles
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      currentApi?.updateArticle('remote-article', { content: 'x'.repeat(70 * 1024) });
    });

    window.dispatchEvent(new Event('beforeunload'));

    const keepaliveCalls = fetchMock.mock.calls.filter(([, init]) => (
      typeof init === 'object' &&
      init !== null &&
      'keepalive' in init &&
      init.keepalive === true
    ));

    expect(keepaliveCalls).toHaveLength(0);
    expect(window.localStorage.getItem('blog-local-articles')).toContain('remote-article');
    expect(window.localStorage.getItem('blog-local-articles')).toContain('x'.repeat(70 * 1024));
    expect(window.localStorage.getItem('blog-local-articles-meta')).toContain('true');
  });

  it('loads valid article updates from storage events in another tab', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        articles: [remoteArticle],
        revision: 'revision-1',
      })
    );

    await act(async () => {
      root.render(
        <TestLocalArticles
          onReady={(api) => {
            currentApi = api;
          }}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'blog-local-articles',
        newValue: JSON.stringify([localArticle]),
        storageArea: window.localStorage,
      }));
    });

    expect(currentApi?.articles).toHaveLength(1);
    expect(currentApi?.articles[0]?.title).toBe('Local Article');
  });
});
