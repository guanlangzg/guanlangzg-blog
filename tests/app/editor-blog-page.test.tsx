import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogEditorPage from '@/app/editor/(authenticated)/blog/page';
import type { Article } from '@/app/types/article';

const pushMock = vi.fn();
const exportArticleMock = vi.fn();
const exportArticlesDataMock = vi.fn();
const deleteArticleMock = vi.fn();
const importArticleMock = vi.fn();
const updateArticleMock = vi.fn();
let articlesMock: Article[] = [];
let lastConflictAtMock: number | null = null;
let lastRemoteLoadErrorMock: { at: number; message: string } | null = null;
let lastRemoteSaveErrorMock: { at: number; message: string } | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('@/app/hooks/useLocalArticles', () => ({
  useLocalArticles: () => ({
    articles: articlesMock,
    deleteArticle: deleteArticleMock,
    exportArticle: exportArticleMock,
    exportArticlesData: exportArticlesDataMock,
    importArticle: importArticleMock,
    isLoaded: true,
    lastConflictAt: lastConflictAtMock,
    lastRemoteLoadError: lastRemoteLoadErrorMock,
    lastRemoteSaveError: lastRemoteSaveErrorMock,
    updateArticle: updateArticleMock,
  }),
}));

vi.mock('@/app/editor/blog/components/TemplateSelector', () => ({
  TemplateSelector: () => <div>template-selector</div>,
}));

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">logout</button>,
}));

describe('BlogEditorPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  const createObjectURLMock = vi.fn(() => 'blob:articles');
  const revokeObjectURLMock = vi.fn();

  beforeEach(() => {
    articlesMock = [
      {
        id: 'article-1',
        title: 'First Article',
        date: '2026-03-09',
        description: 'Desc',
        tags: ['nextjs'],
        content: '# First',
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    pushMock.mockReset();
    exportArticleMock.mockReset().mockReturnValue('# First');
    exportArticlesDataMock.mockReset().mockReturnValue(
      JSON.stringify(
        [
          {
            id: 'article-1',
            title: 'First Article',
          },
        ],
        null,
        2
      )
    );
    deleteArticleMock.mockReset();
    importArticleMock.mockReset();
    updateArticleMock.mockReset().mockImplementation((id: string, updates: Partial<Article>) => {
      const target = articlesMock.find((article) => article.id === id);

      return target ? { ...target, ...updates, updatedAt: Date.now() } : null;
    });
    lastConflictAtMock = null;
    lastRemoteLoadErrorMock = null;
    lastRemoteSaveErrorMock = null;
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    vi.stubGlobal('URL', {
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders a single export button and downloads one JSON file for all articles', () => {
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    const removeChildSpy = vi.spyOn(document.body, 'removeChild');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const exportButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('导出')
    );

    expect(exportButton).toBeTruthy();
    expect(exportButton?.getAttribute('aria-label')).toBe('导出全部文章 JSON');

    act(() => {
      exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const downloadLink = appendChildSpy.mock.calls.at(-1)?.[0];

    expect(downloadLink).toBeInstanceOf(HTMLAnchorElement);
    expect((downloadLink as HTMLAnchorElement).download).toBe('blog-articles.json');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(removeChildSpy).toHaveBeenCalledWith(downloadLink);
    expect(createObjectURLMock).toHaveBeenCalledOnce();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:articles');
    expect(exportArticlesDataMock).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Export All');

    appendChildSpy.mockRestore();
    removeChildSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('keeps markdown import available through an accessible file input', () => {
    act(() => {
      root.render(<BlogEditorPage />);
    });

    const importInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="导入文章 Markdown"]');

    expect(importInput).toBeInstanceOf(HTMLInputElement);
    expect(importInput?.accept).toBe('.md,.markdown');
    expect(importInput?.className).toContain('sr-only');
    expect(importInput?.className).not.toContain('hidden');
  });

  it('shows feedback when the selected markdown file cannot be read', () => {
    class FailingFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onabort: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsText() {
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
      }
    }

    vi.stubGlobal('FileReader', FailingFileReader);

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const importInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="导入文章 Markdown"]');

    expect(importInput).toBeInstanceOf(HTMLInputElement);

    Object.defineProperty(importInput, 'files', {
      configurable: true,
      value: [new File(['# Article'], 'article.md', { type: 'text/markdown' })],
    });

    act(() => {
      importInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(importArticleMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('文章文件读取失败，请重新选择 Markdown 文件。');
  });

  it('shows a warning when remote article data wins a save conflict', () => {
    lastConflictAtMock = Date.now();

    act(() => {
      root.render(<BlogEditorPage />);
    });

    expect(container.textContent).toContain('服务器上的文章数据更新较新');
    expect(container.textContent).toContain('已载入服务器版本');
  });

  it('shows a warning when article data fails to sync to the server', () => {
    lastRemoteSaveErrorMock = {
      at: Date.now(),
      message: '服务器未配置持久化数据目录，文章只保存在当前浏览器。',
    };

    act(() => {
      root.render(<BlogEditorPage />);
    });

    expect(container.textContent).toContain('文章已保存在本机，但同步到服务器失败');
    expect(container.textContent).toContain('服务器未配置持久化数据目录');
  });

  it('shows a warning when article data fails to load from the server', () => {
    lastRemoteLoadErrorMock = {
      at: Date.now(),
      message: '编辑口令已过期。',
    };

    act(() => {
      root.render(<BlogEditorPage />);
    });

    expect(container.textContent).toContain('文章从服务器加载失败，当前显示本机副本');
    expect(container.textContent).toContain('编辑口令已过期');
  });

  it('classifies a complete draft without presenting it as a Pages release', () => {
    articlesMock = [
      {
        id: 'article-1',
        title: 'Ready Draft',
        date: '2026-03-09',
        description: 'Ready to publish',
        tags: ['nextjs'],
        content: '# Ready',
        status: 'draft',
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const classificationButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="标记为已发布（编辑分类）：Ready Draft"]'
    );

    expect(classificationButton?.textContent).toContain('标记为已发布');
    expect(container.textContent).toContain('文章状态仅用于编辑分类');
    expect(container.textContent).toContain('不会发布到 Pages');
    expect(container.textContent).not.toContain('已上线');

    act(() => {
      classificationButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateArticleMock).toHaveBeenCalledWith('article-1', { status: 'published' });
    expect(container.textContent).toContain('文章已标记为已发布（编辑分类）');
    expect(container.textContent).not.toContain('Pages 已发布');
  });

  it('opens article editing from the native article card button', () => {
    act(() => {
      root.render(<BlogEditorPage />);
    });

    const editCardButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="编辑文章：First Article"]'
    );

    expect(editCardButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      editCardButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledWith('/editor/blog/new?edit=article-1');
  });

  it('keeps keyboard focus styles on article card icon actions', () => {
    articlesMock = [
      {
        id: 'article-1',
        slug: 'first-article',
        title: 'First Article',
        date: '2026-03-09',
        description: 'Desc',
        tags: ['nextjs'],
        content: '# First',
        status: 'published',
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const previewLink = container.querySelector<HTMLAnchorElement>('a[aria-label="预览公开文章：First Article"]');
    const editButtons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="编辑文章：First Article"]');
    const exportButton = container.querySelector<HTMLButtonElement>('button[aria-label="导出文章：First Article"]');
    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除文章：First Article"]');

    expect(editButtons).toHaveLength(2);

    for (const action of [previewLink, editButtons[1], exportButton, deleteButton]) {
      expect(action).toBeTruthy();
      expect(action?.className).toContain('min-h-11');
      expect(action?.className).toContain('min-w-11');
      expect(action?.className).toContain('focus:ring-2');
      expect(action?.className).toContain('focus:ring-link');
    }
  });

  it('blocks publishing an incomplete draft from the article list', () => {
    articlesMock = [
      {
        id: 'article-1',
        title: '',
        date: '2026-03-09',
        description: 'Ready to publish',
        tags: ['nextjs'],
        content: '# Ready',
        status: 'draft',
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const publishButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="标记为已发布（编辑分类）：无标题"]'
    );

    act(() => {
      publishButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('标记为已发布（编辑分类）前需要处理：标题已填写。此操作不会发布到 Pages。');
    const editRecoveryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('去编辑')
    );

    expect(editRecoveryButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      editRecoveryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledWith('/editor/blog/new?edit=article-1');
  });

  it('moves a published article back to draft from the article list', () => {
    articlesMock = [
      {
        id: 'article-1',
        title: 'Published Article',
        date: '2026-03-09',
        description: 'Published article',
        tags: ['nextjs'],
        content: '# Published',
        status: 'published',
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const draftButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="标记为草稿（编辑分类）：Published Article"]'
    );

    expect(draftButton).toBeTruthy();

    act(() => {
      draftButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateArticleMock).toHaveBeenCalledWith('article-1', { status: 'draft' });
    expect(container.textContent).toContain('文章已标记为草稿（编辑分类）；此操作不会从 Pages 撤下内容。');
  });

  it('filters articles from metric buttons and clears active filters', () => {
    articlesMock = [
      {
        id: 'draft-article',
        title: 'Draft Article',
        date: '2026-03-09',
        description: 'Draft article',
        tags: ['draft'],
        content: '# Draft',
        status: 'draft',
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: 'featured-article',
        title: 'Featured Article',
        date: '2026-03-10',
        description: 'Featured article',
        tags: ['featured'],
        content: '# Featured',
        status: 'published',
        featured: true,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'plain-article',
        title: 'Plain Article',
        date: '2026-03-11',
        description: 'Plain article',
        tags: ['plain'],
        content: '# Plain',
        status: 'published',
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const draftMetric = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('草稿') && button.textContent.includes('1')
    );

    act(() => {
      draftMetric?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('当前显示 1 / 3 篇');
    expect(container.textContent).toContain('状态：草稿');
    expect(container.textContent).toContain('Draft Article');
    expect(container.textContent).not.toContain('Featured Article');

    const featuredMetric = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('精选') && button.textContent.includes('1')
    );

    act(() => {
      featuredMetric?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('仅精选');
    expect(container.textContent).toContain('当前显示 0 / 3 篇');
    expect(container.textContent).toContain('没有匹配的文章');
    expect(container.textContent).toContain('当前筛选没有结果，清除筛选后可以回到完整文章列表。');

    const clearButton = Array.from(container.querySelectorAll('button')).reverse().find((button) =>
      button.textContent?.includes('清除筛选')
    );

    act(() => {
      clearButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('当前显示 3 / 3 篇');
    expect(container.textContent).toContain('未应用筛选');
    expect(container.textContent).toContain('Featured Article');
    expect(container.textContent).toContain('Plain Article');
  });

  it('filters articles by workflow tabs and shows quality summaries', () => {
    articlesMock = [
      {
        id: 'needs-fix-draft',
        title: '',
        date: '2026-03-09',
        description: '',
        tags: ['draft'],
        content: '# Draft',
        status: 'draft',
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: 'ready-draft',
        title: 'Ready Draft',
        date: '2026-03-10',
        description: 'Ready draft has the minimum public description.',
        tags: ['ready'],
        content: '# Ready Draft',
        status: 'draft',
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 'published-article',
        title: 'Published Article',
        date: '2026-03-11',
        description: 'Published article',
        tags: ['published'],
        content: '# Published',
        status: 'published',
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    expect(container.textContent).toContain('发布阻塞 2');
    expect(container.textContent).toContain('可发布');
    expect(container.textContent).toContain('发布建议');

    const needsFixTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('待修复') && button.textContent.includes('1')
    );

    expect(needsFixTab).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      needsFixTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('当前显示 1 / 3 篇');
    expect(container.textContent).toContain('工作流：待修复');
    expect(container.textContent).toContain('无标题');
    expect(container.textContent).not.toContain('Ready Draft');

    const readyTab = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('可发布') && button.textContent.includes('1')
    );

    act(() => {
      readyTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('当前显示 1 / 3 篇');
    expect(container.textContent).toContain('工作流：可发布');
    expect(container.textContent).toContain('Ready Draft');
    expect(container.textContent).not.toContain('Published Article');
  });

  it('gives the article search input an accessible name', () => {
    act(() => {
      root.render(<BlogEditorPage />);
    });

    const searchInput = container.querySelector<HTMLInputElement>('input[aria-label="搜索文章"]');

    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect(searchInput?.placeholder).toBe('搜索标题、描述或标签');
  });

  it('removes individual active filters from filter chips', () => {
    articlesMock = [
      {
        id: 'draft-article',
        title: 'Draft Article',
        date: '2026-03-09',
        description: 'Draft article',
        tags: ['draft'],
        content: '# Draft',
        status: 'draft',
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: 'published-article',
        title: 'Published Article',
        date: '2026-03-10',
        description: 'Published article',
        tags: ['published'],
        content: '# Published',
        status: 'published',
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    act(() => {
      root.render(<BlogEditorPage />);
    });

    const draftMetric = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('草稿') && button.textContent.includes('1')
    );

    act(() => {
      draftMetric?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const removeStatusFilterButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="移除筛选：状态：草稿"]'
    );

    expect(removeStatusFilterButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).toContain('当前显示 1 / 2 篇');
    expect(container.textContent).toContain('Draft Article');
    expect(container.textContent).not.toContain('Published Article');

    act(() => {
      removeStatusFilterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('当前显示 2 / 2 篇');
    expect(container.textContent).toContain('未应用筛选');
    expect(container.textContent).toContain('Published Article');
  });
});
