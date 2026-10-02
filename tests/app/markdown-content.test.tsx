import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/app/components/markdown';

describe('MarkdownContent', () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeTextMock = vi.fn();
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
    writeTextMock.mockResolvedValue(undefined);
    setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    setTimeoutSpy.mockRestore();
    writeTextMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders code block chrome and copies the raw code text', async () => {
    act(() => {
      root.render(
        <MarkdownContent content={'```typescript\nconst ok = true;\n```'} />
      );
    });

    expect(container.textContent).toContain('typescript');

    const copyButton = container.querySelector('button[aria-label="复制代码"]');

    expect(copyButton).toBeInstanceOf(HTMLButtonElement);
    expect(copyButton?.className).toBe('markdown-code-block__copy');

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeTextMock).toHaveBeenCalledWith('const ok = true;');
  });

  it('does not render dangerous markdown HTML or protocols as active DOM', () => {
    act(() => {
      root.render(
        <MarkdownContent
          content={'<script>alert("xss")</script>\n\n[unsafe](javascript:alert("xss"))\n\n<img src="x" onerror="alert(\'xss\')" />'}
        />
      );
    });

    const unsafeLink = Array.from(container.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('unsafe')
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(unsafeLink?.getAttribute('href')).toBeNull();
  });

  it('uses the shared heading id format for markdown links and inline code', () => {
    act(() => {
      root.render(
        <MarkdownContent content={'## [MDN Docs](https://developer.mozilla.org) and `fetch`'} />
      );
    });

    expect(container.querySelector('h2')?.id).toBe('MDN%20Docs%20and%20fetch');
  });

  it('renders duplicate heading ids with the same suffixes as the outline parser', () => {
    act(() => {
      root.render(
        <MarkdownContent content={'# Intro\n\n## Review\n\n### Review\n\n## Review'} />
      );
    });

    expect(Array.from(container.querySelectorAll('h1, h2, h3')).map((heading) => heading.id)).toEqual([
      'Intro',
      'Review',
      'Review-2',
      'Review-3',
    ]);
  });

  it('skips the first h1 when it duplicates the page title', () => {
    act(() => {
      root.render(
        <MarkdownContent content={'\n# Article Title\n\n## Section'} skipDuplicateTitle="Article Title" />
      );
    });

    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Section');
  });

  it('keeps h1 content when it is not the first duplicate page title', () => {
    act(() => {
      root.render(
        <MarkdownContent content={'## Lead\n\n# Article Title'} skipDuplicateTitle="Article Title" />
      );
    });

    expect(container.querySelector('h1')?.textContent).toBe('Article Title');
  });
});
