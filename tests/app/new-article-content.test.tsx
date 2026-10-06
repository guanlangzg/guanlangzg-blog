import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewArticleContent } from '@/app/editor/(authenticated)/blog/new/NewArticleContent';
import type { Article, Frontmatter } from '@/app/types/article';
import { getArticleDraftKey, readStoredDraft } from '@/lib/article-draft-storage';

const replaceMock = vi.fn();
const createArticleMock = vi.fn();
const updateArticleContentMock = vi.fn();
const getArticleByIdMock = vi.fn();
const exportArticleMock = vi.fn();
const DRAFT_KEY = getArticleDraftKey('new:blank');

// Stateful search params double so tests can apply the same route transition
// router.replace requests in the real app.
let searchParamsValue = 'template=blank';
const searchParamsListeners = new Set<() => void>();

function setSearchParams(next: string): void {
  searchParamsValue = next;

  for (const listener of searchParamsListeners) {
    listener();
  }
}

function useSearchParamsDouble(): URLSearchParams {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((value) => value + 1);
    searchParamsListeners.add(listener);

    return () => {
      searchParamsListeners.delete(listener);
    };
  }, []);

  return new URLSearchParams(searchParamsValue);
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
  useSearchParams: () => useSearchParamsDouble(),
}));

vi.mock('@/app/hooks/useLocalArticles', () => ({
  useLocalArticles: () => ({
    createArticle: createArticleMock,
    updateArticleContent: updateArticleContentMock,
    getArticleById: getArticleByIdMock,
    exportArticle: exportArticleMock,
    isLoaded: true,
    lastConflictAt: null,
    lastRemoteLoadError: null,
    lastRemoteSaveError: null,
  }),
}));

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">logout</button>,
}));

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }

  return button;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressSaveShortcut(textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

describe('NewArticleContent', () => {
  let container: HTMLDivElement;
  let root: Root;
  let isMounted: boolean;
  let articles: Article[];

  function createStoredArticle(frontmatter: Frontmatter, content: string): Article {
    const article: Article = {
      id: `article-${articles.length + 1}`,
      title: frontmatter.title || 'Untitled',
      slug: 'article-slug',
      date: frontmatter.date,
      description: frontmatter.description ?? '',
      kind: frontmatter.kind ?? 'essay',
      status: frontmatter.status ?? 'draft',
      featured: Boolean(frontmatter.featured),
      tags: frontmatter.tags ?? [],
      content,
      createdAt: 1,
      updatedAt: 1,
    };

    articles = [article, ...articles];

    return article;
  }

  function unmountRoot(): void {
    if (!isMounted) {
      return;
    }

    isMounted = false;
    act(() => {
      root.unmount();
    });
  }

  beforeEach(() => {
    replaceMock.mockReset();
    createArticleMock.mockReset().mockImplementation((frontmatter: Frontmatter, content: string) =>
      createStoredArticle(frontmatter, content)
    );
    updateArticleContentMock.mockReset().mockImplementation((id: string, frontmatter: Frontmatter, content: string) => {
      const existing = articles.find((article) => article.id === id);

      if (!existing) {
        return null;
      }

      const updated: Article = {
        ...existing,
        title: frontmatter.title,
        date: frontmatter.date,
        description: frontmatter.description,
        kind: frontmatter.kind ?? 'essay',
        status: frontmatter.status ?? 'draft',
        featured: Boolean(frontmatter.featured),
        tags: frontmatter.tags ?? [],
        content,
        updatedAt: 2,
      };

      articles = articles.map((article) => (article.id === id ? updated : article));

      return updated;
    });
    getArticleByIdMock.mockReset().mockImplementation((id: string) =>
      articles.find((article) => article.id === id)
    );
    exportArticleMock.mockReset().mockReturnValue('# Article');
    articles = [];
    searchParamsValue = 'template=blank';
    searchParamsListeners.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    isMounted = true;
  });

  afterEach(() => {
    unmountRoot();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('focuses the first blocking metadata field when save validation fails', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    await act(async () => {
      getButtonByText(container, '添加资料').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const sourceTitleInput = container.querySelector<HTMLInputElement>('#frontmatter-source-title-0');
    const sourceUrlInput = container.querySelector<HTMLInputElement>('#frontmatter-source-url-0');
    const saveButton = getButtonByText(container, '保存');

    expect(sourceTitleInput).toBeInstanceOf(HTMLInputElement);
    expect(sourceUrlInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      if (sourceTitleInput) {
        setInputValue(sourceTitleInput, 'Unsafe Docs');
      }

      if (sourceUrlInput) {
        setInputValue(sourceUrlInput, 'javascript:alert(1)');
      }
    });

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(sourceUrlInput).toBe(document.activeElement);
    expect(sourceUrlInput?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('保存前需要处理：参考资料链接安全有效。');
    expect(createArticleMock).not.toHaveBeenCalled();
  });

  it('summarizes publishing readiness above the mobile writing workspace', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const shortcut = container.querySelector<HTMLElement>('section[aria-labelledby="mobile-publishing-shortcut-title"]');
    const detailsButton = getButtonByText(container, '检查文章信息');
    const frontmatterPanel = container.querySelector<HTMLElement>('#article-frontmatter-panel');

    expect(shortcut).toBeInstanceOf(HTMLElement);
    expect(shortcut?.textContent).toContain('发布概览');
    expect(shortcut?.textContent).toContain('先确认标题、描述、标签和公开路径，再继续写正文。');
    expect(shortcut?.textContent).toContain('1 阻塞');
    expect(shortcut?.textContent).toContain('保存');
    expect(shortcut?.textContent).toContain('未入库');
    expect(shortcut?.textContent).toContain('草稿');
    expect(shortcut?.textContent).toContain('0 个');
    expect(shortcut?.textContent).toContain('0 字');
    expect(frontmatterPanel).toBeInstanceOf(HTMLElement);

    await act(async () => {
      detailsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(frontmatterPanel).toBe(document.activeElement);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('keeps first-time article saves visually primary until the article is persisted', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const saveButton = getButtonByText(container, '保存');

    expect(container.textContent).toContain('尚未保存到文章库');
    expect(container.textContent).not.toContain('内容已保存');
    expect(saveButton.className).toContain('bg-fg');
  });

  it('creates a single article when the save shortcut is pressed twice in a row', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor');

    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      setTextareaValue(textarea as HTMLTextAreaElement, 'First body');
    });
    await act(async () => {
      pressSaveShortcut(textarea as HTMLTextAreaElement);
      pressSaveShortcut(textarea as HTMLTextAreaElement);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(1);
    expect(articles).toHaveLength(1);
    expect(articles[0]?.content).toBe('First body');
  });

  it('updates the created article instead of creating another one when saving again before the route switches', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'First body');
    });
    await act(async () => {
      pressSaveShortcut(textarea);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setTextareaValue(textarea, 'Second body');
    });
    await act(async () => {
      pressSaveShortcut(textarea);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(1);
    expect(updateArticleContentMock).toHaveBeenCalledWith('article-1', expect.anything(), 'Second body');
    expect(articles).toHaveLength(1);
    expect(articles[0]?.content).toBe('Second body');
  });

  it('keeps saving into the created article after the new-article route switches to its edit URL', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'First body');
    });
    await act(async () => {
      pressSaveShortcut(textarea);
    });

    expect(replaceMock).toHaveBeenCalledWith('/editor/blog/new?edit=article-1');

    await act(async () => {
      setSearchParams('edit=article-1');
    });

    const reloadedTextarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    expect(container.textContent).toContain('编辑文章');
    expect(reloadedTextarea.value).toBe('First body');

    await act(async () => {
      setTextareaValue(reloadedTextarea, 'First body revised');
    });
    await act(async () => {
      pressSaveShortcut(reloadedTextarea);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(1);
    expect(updateArticleContentMock).toHaveBeenLastCalledWith('article-1', expect.anything(), 'First body revised');
  });

  it('creates a new article when the editor returns to the blank new-article route', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'First body');
    });
    await act(async () => {
      pressSaveShortcut(textarea);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setSearchParams('edit=article-1');
    });
    // Going back to the blank URL is a new article; the component instance survives
    // the query-only route change, so the previously created id must not be reused.
    await act(async () => {
      setSearchParams('template=blank');
    });

    const blankTextarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(blankTextarea, 'Second body');
    });
    await act(async () => {
      pressSaveShortcut(blankTextarea);
    });

    expect(createArticleMock).toHaveBeenCalledTimes(2);
    expect(updateArticleContentMock).not.toHaveBeenCalledWith('article-1', expect.anything(), 'Second body');
    expect(articles.map((article) => article.content).sort()).toEqual(['First body', 'Second body']);
  });

  it('flushes the unsaved draft before unload and on unmount', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'Draft body');
    });

    expect(readStoredDraft(DRAFT_KEY)).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(readStoredDraft(DRAFT_KEY)?.content).toBe('Draft body');

    await act(async () => {
      setTextareaValue(textarea, 'Draft body updated');
    });
    unmountRoot();

    expect(readStoredDraft(DRAFT_KEY)?.content).toBe('Draft body updated');
  });

  it('does not recreate the cleared draft after a successful save', async () => {
    await act(async () => {
      root.render(<NewArticleContent />);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#article-markdown-editor') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(textarea, 'Saved body');
    });
    await act(async () => {
      pressSaveShortcut(textarea);
    });

    expect(readStoredDraft(DRAFT_KEY)).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    unmountRoot();

    expect(readStoredDraft(DRAFT_KEY)).toBeNull();
  });
});
