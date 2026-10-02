import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewArticleContent } from '@/app/editor/(authenticated)/blog/new/NewArticleContent';

const replaceMock = vi.fn();
const createArticleMock = vi.fn();
const updateArticleContentMock = vi.fn();
const getArticleByIdMock = vi.fn();
const exportArticleMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
  useSearchParams: () => new URLSearchParams('template=blank'),
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

describe('NewArticleContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    replaceMock.mockReset();
    createArticleMock.mockReset();
    updateArticleContentMock.mockReset();
    getArticleByIdMock.mockReset();
    exportArticleMock.mockReset().mockReturnValue('# Article');
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
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
});
