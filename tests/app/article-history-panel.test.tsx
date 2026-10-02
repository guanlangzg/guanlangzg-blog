import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleHistoryPanel } from '@/app/editor/components/ArticleHistoryPanel';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

function makeResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('ArticleHistoryPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    push.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('loads stable-ID pages and appends earlier versions', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ items: [{ commitSha: 'a'.repeat(40), title: '版本一', committedAt: '2026-01-01T00:00:00Z', message: 'save' }], nextCursor: '2' }))
      .mockResolvedValueOnce(makeResponse({ items: [{ commitSha: 'b'.repeat(40), title: '版本二', committedAt: '2025-12-01T00:00:00Z', message: 'save' }], nextCursor: null }));
    await act(async () => {
      root.render(<ArticleHistoryPanel articleId="stable-article-id" articleTitle="当前文章" onClose={() => {}} />);
    });
    expect(container.textContent).toContain('版本一');
    expect(fetchMock.mock.calls[0][0]).toContain('/articles/stable-article-id/history?');
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('加载更早版本'))?.click();
    });
    expect(container.textContent).toContain('版本二');
    expect(fetchMock.mock.calls[1][0]).toContain('cursor=2');
  });

  it('shows GitHub-not-ready as an error instead of empty history', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ code: 'GITHUB_NOT_READY' }, 503));
    await act(async () => {
      root.render(<ArticleHistoryPanel articleId="stable-id" articleTitle="文章" onClose={() => {}} />);
    });
    expect(container.textContent).toContain('GitHub 备份未连接或当前不可用');
    expect(container.textContent).not.toContain('远端没有此文章的历史版本');
  });

  it('restores a selected commit as a draft and navigates to the article editor', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ items: [{ commitSha: 'c'.repeat(40), title: '旧版', committedAt: '2026-01-01T00:00:00Z', message: 'save' }], nextCursor: null }))
      .mockResolvedValueOnce(makeResponse({ articleId: 'stable-id', status: 'draft' }, 202));
    await act(async () => {
      root.render(<ArticleHistoryPanel articleId="stable-id" articleTitle="文章" onClose={() => {}} />);
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('恢复为草稿'))?.click();
    });
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ commitSha: 'c'.repeat(40) });
    expect(push).toHaveBeenCalledWith('/editor/blog/new?edit=stable-id');
    expect(container.textContent).toContain('尚未发布');
  });
});
