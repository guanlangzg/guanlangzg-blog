import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NavigationEditorPage from '@/app/editor/(authenticated)/navigation/page';

const addCategoryMock = vi.fn();
const updateCategoryMock = vi.fn();
const deleteCategoryMock = vi.fn();
const addToolMock = vi.fn();
const updateToolMock = vi.fn();
const deleteToolMock = vi.fn();
const exportDataMock = vi.fn();
const importDataMock = vi.fn();
const resetToDefaultMock = vi.fn();
let lastConflictAtMock: number | null = null;
let lastRemoteLoadErrorMock: { at: number; message: string } | null = null;
let lastRemoteSaveErrorMock: { at: number; message: string } | null = null;

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

vi.mock('@/app/hooks/useNavigationData', () => ({
  useNavigationData: () => ({
    data: [
      {
        name: 'AI Tools',
        icon: 'folder',
        slug: 'ai-tools',
        tools: [
          {
            icon: 'link',
            title: 'OpenAI',
            description: 'AI platform',
            url: 'https://openai.com',
            tags: ['ai'],
          },
        ],
      },
    ],
    isLoaded: true,
    addCategory: addCategoryMock,
    updateCategory: updateCategoryMock,
    deleteCategory: deleteCategoryMock,
    addTool: addToolMock,
    updateTool: updateToolMock,
    deleteTool: deleteToolMock,
    exportData: exportDataMock,
    importData: importDataMock,
    resetToDefault: resetToDefaultMock,
    lastConflictAt: lastConflictAtMock,
    lastRemoteLoadError: lastRemoteLoadErrorMock,
    lastRemoteSaveError: lastRemoteSaveErrorMock,
  }),
}));

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">logout</button>,
}));

describe('NavigationEditorPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    addCategoryMock.mockReset();
    updateCategoryMock.mockReset();
    deleteCategoryMock.mockReset();
    addToolMock.mockReset();
    updateToolMock.mockReset();
    deleteToolMock.mockReset();
    exportDataMock.mockReset().mockReturnValue('[]');
    importDataMock.mockReset().mockReturnValue(true);
    resetToDefaultMock.mockReset();
    lastConflictAtMock = null;
    lastRemoteLoadErrorMock = null;
    lastRemoteSaveErrorMock = null;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
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

  it('shows a warning when remote navigation data wins a save conflict', () => {
    lastConflictAtMock = Date.now();

    act(() => {
      root.render(<NavigationEditorPage />);
    });

    expect(container.textContent).toContain('服务器上的导航数据更新较新');
    expect(container.textContent).toContain('已载入服务器版本');
  });

  it('shows a warning when navigation data fails to sync to the server', () => {
    lastRemoteSaveErrorMock = {
      at: Date.now(),
      message: '服务器未配置持久化数据目录，导航只保存在当前浏览器。',
    };

    act(() => {
      root.render(<NavigationEditorPage />);
    });

    expect(container.textContent).toContain('导航已保存在本机，但同步到服务器失败');
    expect(container.textContent).toContain('服务器未配置持久化数据目录');
  });

  it('shows a warning when navigation data fails to load from the server', () => {
    lastRemoteLoadErrorMock = {
      at: Date.now(),
      message: '导航数据文件损坏。',
    };

    act(() => {
      root.render(<NavigationEditorPage />);
    });

    expect(container.textContent).toContain('导航从服务器加载失败，当前显示本机副本');
    expect(container.textContent).toContain('导航数据文件损坏');
  });

  it('keeps navigation import available through an accessible file input', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const importInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="导入导航数据"]');
    const exportButton = container.querySelector<HTMLButtonElement>('button[aria-label="导出导航数据"]');
    const resetButton = container.querySelector<HTMLButtonElement>('button[aria-label="重置导航数据"]');

    expect(importInput).toBeInstanceOf(HTMLInputElement);
    expect(importInput?.accept).toBe('.json');
    expect(importInput?.className).toContain('sr-only');
    expect(importInput?.className).not.toContain('hidden');
    expect(exportButton).toBeInstanceOf(HTMLButtonElement);
    expect(resetButton).toBeInstanceOf(HTMLButtonElement);
  });

  it('shows feedback when the selected navigation file cannot be read', () => {
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
      root.render(<NavigationEditorPage />);
    });

    const importInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="导入导航数据"]');

    expect(importInput).toBeInstanceOf(HTMLInputElement);

    Object.defineProperty(importInput, 'files', {
      configurable: true,
      value: [new File(['[]'], 'navigation.json', { type: 'application/json' })],
    });

    act(() => {
      importInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(importDataMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('导航数据文件读取失败，请重新选择 JSON 文件。');
  });

  it('marks and focuses the first invalid field when adding a tool', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const addToolButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加工具')
    );

    act(() => {
      addToolButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认添加')
    );

    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const titleInput = container.querySelector<HTMLInputElement>('#new-tool-0-title');
    const urlInput = container.querySelector<HTMLInputElement>('#new-tool-0-url');

    expect(titleInput).toBe(document.activeElement);
    expect(titleInput?.getAttribute('aria-invalid')).toBe('true');
    expect(titleInput?.getAttribute('aria-describedby')).toBe('new-tool-0-title-error');
    expect(urlInput?.type).toBe('url');
    expect(urlInput?.inputMode).toBe('url');
    expect(urlInput?.getAttribute('autocapitalize')).toBe('none');
    expect(urlInput?.getAttribute('autocorrect')).toBe('off');
    expect(urlInput?.getAttribute('spellcheck')).toBe('false');
    expect(container.textContent).toContain('添加工具到 AI Tools');
    expect(container.textContent).toContain('先补齐名称、URL、描述和标签');
    expect(container.querySelector('#new-tool-0-title-error')?.textContent).toBe('请填写工具名称。');
    expect(addToolMock).not.toHaveBeenCalled();
  });

  it('marks and focuses the category name field when adding an empty category', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const addCategoryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加分类')
    );

    act(() => {
      addCategoryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认添加')
    );

    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector<HTMLInputElement>('#new-category-name');

    expect(nameInput).toBe(document.activeElement);
    expect(nameInput?.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput?.getAttribute('aria-describedby')).toBe('new-category-name-error');
    expect(container.querySelector('#new-category-name-error')?.textContent).toBe('请填写分类名称。');
    expect(addCategoryMock).not.toHaveBeenCalled();

    act(() => {
      if (nameInput) {
        setInputValue(nameInput, 'Docs');
      }
    });

    expect(nameInput?.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('#new-category-name-error')).toBeNull();
  });

  it('keeps focus on the category name field when saving an empty category edit', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '编辑分类：AI Tools'
    );

    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector<HTMLInputElement>('#edit-category-0-name');
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '保存分类：AI Tools'
    );

    expect(nameInput?.value).toBe('AI Tools');

    act(() => {
      if (nameInput) {
        setInputValue(nameInput, '   ');
      }
    });

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(nameInput).toBe(document.activeElement);
    expect(nameInput?.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput?.getAttribute('aria-describedby')).toBe('edit-category-0-name-error');
    expect(container.querySelector('#edit-category-0-name-error')?.textContent).toBe('请填写分类名称。');
    expect(updateCategoryMock).not.toHaveBeenCalled();

    act(() => {
      if (nameInput) {
        setInputValue(nameInput, 'AI Resources');
      }
    });

    expect(nameInput?.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('#edit-category-0-name-error')).toBeNull();
  });

  it('cancels category inline editing with Escape without saving', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '编辑分类：AI Tools'
    );

    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = container.querySelector<HTMLInputElement>('#edit-category-0-name');

    act(() => {
      if (nameInput) {
        setInputValue(nameInput, 'AI Resources');
        nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    });

    expect(container.querySelector('#edit-category-0-name')).toBeNull();
    expect(updateCategoryMock).not.toHaveBeenCalled();
  });

  it('marks and focuses the invalid URL field when editing a tool', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '编辑工具：OpenAI'
    );

    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('编辑工具：OpenAI');
    expect(container.textContent).toContain('修改会直接更新当前分类里的链接条目');

    const urlInput = container.querySelector<HTMLInputElement>('#edit-tool-0-0-url');
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存')
    );

    expect(urlInput).toBeInstanceOf(HTMLInputElement);
    expect(urlInput?.type).toBe('url');
    expect(urlInput?.inputMode).toBe('url');
    expect(urlInput?.getAttribute('autocapitalize')).toBe('none');
    expect(urlInput?.getAttribute('autocorrect')).toBe('off');
    expect(urlInput?.getAttribute('spellcheck')).toBe('false');

    act(() => {
      if (urlInput) {
        setInputValue(urlInput, 'notaurl');
      }
    });

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(urlInput).toBe(document.activeElement);
    expect(urlInput?.getAttribute('aria-invalid')).toBe('true');
    expect(urlInput?.getAttribute('aria-describedby')).toBe('edit-tool-0-0-url-error');
    expect(container.querySelector('#edit-tool-0-0-url-error')?.textContent).toContain('URL 必须是完整的 https:// 链接');
    expect(updateToolMock).not.toHaveBeenCalled();
  });

  it('requires a second click before deleting a tool link', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '删除工具：OpenAI'
    );

    expect(deleteButton).toBeTruthy();

    act(() => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteToolMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('再次点击删除按钮确认删除工具链接');

    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '确认删除工具：OpenAI'
    );

    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteToolMock).toHaveBeenCalledWith(0, 0);
  });

  it('keeps keyboard focus styles on tool card icon actions', () => {
    act(() => {
      root.render(<NavigationEditorPage />);
    });

    const openLink = container.querySelector<HTMLAnchorElement>('a[aria-label="打开工具：OpenAI"]');
    const editButton = container.querySelector<HTMLButtonElement>('button[aria-label="编辑工具：OpenAI"]');
    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除工具：OpenAI"]');

    for (const action of [openLink, editButton, deleteButton]) {
      expect(action).toBeTruthy();
      expect(action?.className).toContain('min-h-11');
      expect(action?.className).toContain('min-w-11');
      expect(action?.className).toContain('focus:ring-2');
      expect(action?.className).toContain('focus:ring-link');
    }
  });
});
