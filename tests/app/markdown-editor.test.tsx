import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '@/app/editor/(authenticated)/blog/components/MarkdownEditor';

describe('MarkdownEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it('formats selected markdown text with keyboard shortcuts', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <MarkdownEditor
          value="Hello"
          onChange={onChange}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    act(() => {
      textarea?.focus();
      textarea?.setSelectionRange(0, 5);
      textarea?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'b',
      }));
    });

    expect(onChange).toHaveBeenCalledWith('**Hello**');
    expect(container.querySelector('button[aria-label="加粗"]')?.getAttribute('aria-keyshortcuts')).toBe('Control+B Meta+B');
  });

  it('exposes the markdown toolbar as a named scrollable toolbar', () => {
    act(() => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={vi.fn()}
          textareaId="markdown-editor-test"
        />
      );
    });

    const toolbar = container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Markdown 格式工具"]');
    const overflowHint = toolbar?.parentElement?.lastElementChild;
    const divider = toolbar?.querySelector('div[aria-hidden="true"]');
    const headingButton = toolbar?.querySelector<HTMLButtonElement>('button[aria-label="标题"]');

    expect(toolbar).toBeInstanceOf(HTMLElement);
    expect(toolbar?.hasAttribute('data-editor-toolbar')).toBe(true);
    expect(toolbar?.className).toContain('overflow-x-auto');
    expect(toolbar?.className).toContain('pr-9');
    expect(overflowHint?.getAttribute('aria-hidden')).toBe('true');
    expect(overflowHint?.className).toContain('bg-gradient-to-l');
    expect(divider).toBeInstanceOf(HTMLDivElement);
    expect(headingButton?.className).toContain('h-11');
    expect(headingButton?.className).toContain('w-11');
  });

  it('keeps a visible keyboard focus style on the writing area', () => {
    act(() => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={vi.fn()}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea?.className).toContain('outline-none');
    expect(textarea?.className).toContain('focus-visible:ring-2');
    expect(textarea?.className).toContain('focus-visible:ring-inset');
  });

  it('formats selected markdown text with strikethrough shortcuts', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <MarkdownEditor
          value="Remove"
          onChange={onChange}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    act(() => {
      textarea?.focus();
      textarea?.setSelectionRange(0, 6);
      textarea?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey: true,
        key: 'x',
      }));
    });

    expect(onChange).toHaveBeenCalledWith('~~Remove~~');
    expect(container.querySelector('button[aria-label="删除线"]')?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+X Meta+Shift+X');
  });

  it('inserts markdown links and keeps save shortcuts available', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();

    act(() => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={onChange}
          onSave={onSave}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    act(() => {
      textarea?.focus();
      textarea?.setSelectionRange(0, 0);
      textarea?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'k',
      }));
    });

    expect(onChange).toHaveBeenCalledWith('[链接文字](https://example.com)');
    expect(container.querySelector('button[aria-label="链接"]')?.getAttribute('aria-keyshortcuts')).toBe('Control+K Meta+K');

    act(() => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 's',
      }));
    });

    expect(onSave).toHaveBeenCalledOnce();
  });

  it('normalizes line prefixes instead of stacking repeated toolbar formatting', () => {
    const onChange = vi.fn();

    act(() => {
      root.render(
        <MarkdownEditor
          value={'## Existing title\n- Existing item\n> Existing quote'}
          onChange={onChange}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');
    const headingButton = container.querySelector<HTMLButtonElement>('button[aria-label="标题"]');
    const listButton = container.querySelector<HTMLButtonElement>('button[aria-label="无序列表"]');
    const quoteButton = container.querySelector<HTMLButtonElement>('button[aria-label="引用"]');

    act(() => {
      textarea?.focus();
      textarea?.setSelectionRange(0, '## Existing title'.length);
      headingButton?.click();
    });

    expect(onChange).toHaveBeenLastCalledWith('## Existing title\n- Existing item\n> Existing quote');

    act(() => {
      root.render(
        <MarkdownEditor
          value="1. Existing item"
          onChange={onChange}
          textareaId="markdown-editor-test"
        />
      );
    });

    const nextTextarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    act(() => {
      nextTextarea?.focus();
      nextTextarea?.setSelectionRange(0, '1. Existing item'.length);
      listButton?.click();
    });

    expect(onChange).toHaveBeenLastCalledWith('- Existing item');

    act(() => {
      root.render(
        <MarkdownEditor
          value="> Existing quote"
          onChange={onChange}
          textareaId="markdown-editor-test"
        />
      );
    });

    const finalTextarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');

    act(() => {
      finalTextarea?.focus();
      finalTextarea?.setSelectionRange(0, '> Existing quote'.length);
      quoteButton?.click();
    });

    expect(onChange).toHaveBeenLastCalledWith('> Existing quote');
  });

  it('uploads pasted clipboard images and replaces the temporary markdown placeholder', async () => {
    let currentValue = 'Intro\n';
    const onChange = vi.fn((nextValue: string) => {
      currentValue = nextValue;
      act(() => {
        root.render(
          <MarkdownEditor
            value={currentValue}
            onChange={onChange}
            onUploadPastedImage={onUploadPastedImage}
            textareaId="markdown-editor-test"
          />
        );
      });
    });
    const imageFile = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const onUploadPastedImage = vi.fn(async () => '![clipboard](/media/files/2026/06/image.png)');

    act(() => {
      root.render(
        <MarkdownEditor
          value={currentValue}
          onChange={onChange}
          onUploadPastedImage={onUploadPastedImage}
          textareaId="markdown-editor-test"
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#markdown-editor-test');
    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as Event & {
      clipboardData: {
        items: Array<{
          kind: string;
          type: string;
          getAsFile: () => File;
        }>;
      };
    };

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    await act(async () => {
      textarea?.focus();
      textarea?.setSelectionRange(currentValue.length, currentValue.length);
      textarea?.dispatchEvent(pasteEvent);
      await Promise.resolve();
    });

    expect(onUploadPastedImage).toHaveBeenCalledWith(imageFile);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('![图片上传中 1](uploading://clipboard-image-'));
    expect(onChange).toHaveBeenLastCalledWith('Intro\n![clipboard](/media/files/2026/06/image.png)');
  });
});
