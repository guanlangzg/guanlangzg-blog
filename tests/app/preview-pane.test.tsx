import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPane } from '@/app/editor/(authenticated)/blog/components/PreviewPane';
import type { Frontmatter } from '@/app/types/article';

vi.mock('@/app/components/markdown', () => ({
  MarkdownContent: ({
    className,
    content,
    skipDuplicateTitle,
  }: {
    className?: string;
    content: string;
    skipDuplicateTitle?: string;
  }) => (
    <div
      data-testid="markdown-content"
      className={className}
      data-skip-duplicate-title={skipDuplicateTitle}
    >
      {content}
    </div>
  ),
}));

describe('PreviewPane', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    vi.unstubAllGlobals();
  });

  it('renders source links and revision notes in the editor preview', async () => {
    const frontmatter: Frontmatter = {
      title: 'Preview Article',
      date: '2026-05-27',
      description: 'Preview description',
      tags: ['preview'],
      category: '工程实践',
      series: 'Preview Series',
      sourceLinks: [
        {
          title: 'Official Docs',
          url: 'https://example.com/docs',
          note: 'Primary reference',
        },
      ],
      revisionNotes: [
        {
          date: '2026-05-28',
          note: 'Added source links',
        },
      ],
    };

    await act(async () => {
      root.render(
        <PreviewPane
          content="# Body"
          frontmatter={frontmatter}
          readingMinutes={1}
        />
      );
    });

    const sourceLink = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');

    expect(container.textContent).toContain('参考资料');
    expect(container.textContent).toContain('工程实践');
    expect(container.textContent).toContain('Preview Series');
    expect(container.textContent).toContain('preview');
    expect(container.textContent).toContain('Official Docs');
    expect(container.textContent).toContain('Primary reference');
    expect(sourceLink?.target).toBe('_blank');
    expect(sourceLink?.rel).toContain('noopener');
    expect(container.textContent).toContain('修订记录');
    expect(container.textContent).toContain('2026-05-28');
    expect(container.textContent).toContain('Added source links');
  });

  it('renders a table of contents when preview content has enough sections', async () => {
    await act(async () => {
      root.render(
        <PreviewPane
          content={[
            '# Body',
            '',
            '## [Context](https://example.com/context)',
            'Text',
            '## Decision',
            'Text',
            '## Rollout',
            'Text',
            '## Review',
            'Text',
          ].join('\n')}
          readingMinutes={1}
        />
      );
    });

    const outlineLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('nav a'));
    const markdownContent = container.querySelector<HTMLElement>('[data-testid="markdown-content"]');

    expect(container.textContent).toContain('目录');
    expect(outlineLinks.map((link) => link.textContent)).toEqual([
      '[Context](https://example.com/context)',
      'Decision',
      'Rollout',
      'Review',
    ]);
    expect(outlineLinks[0]?.getAttribute('href')).toBe('#Context');
    expect(markdownContent?.className).toContain('rounded-token-card');
    expect(markdownContent?.className).toContain('border-border');
    expect(markdownContent?.className).toContain('bg-surface');
  });

  it('passes the frontmatter title to markdown content for duplicate h1 suppression', async () => {
    await act(async () => {
      root.render(
        <PreviewPane
          content="# Preview Article"
          frontmatter={{
            title: 'Preview Article',
            date: '2026-05-27',
            description: 'Preview description',
            tags: [],
          }}
          readingMinutes={1}
        />
      );
    });

    expect(container.querySelector('[data-testid="markdown-content"]')?.getAttribute('data-skip-duplicate-title')).toBe('Preview Article');
  });

  it('uses unique outline hrefs for repeated headings', async () => {
    await act(async () => {
      root.render(
        <PreviewPane
          content={[
            '# Body',
            '',
            '## Review',
            'Text',
            '## Review',
            'Text',
            '### Review',
            'Text',
            '## Review',
            'Text',
          ].join('\n')}
          readingMinutes={1}
        />
      );
    });

    expect(Array.from(container.querySelectorAll<HTMLAnchorElement>('nav a')).map((link) => link.getAttribute('href'))).toEqual([
      '#Review',
      '#Review-2',
      '#Review-3',
      '#Review-4',
    ]);
  });

  it('does not render unsafe source links in preview output', async () => {
    const frontmatter: Frontmatter = {
      title: 'Preview Article',
      date: '2026-05-27',
      description: 'Preview description',
      tags: [],
      sourceLinks: [
        {
          title: 'Unsafe Docs',
          url: 'javascript:alert(1)',
        },
      ],
    };

    await act(async () => {
      root.render(
        <PreviewPane
          content="# Body"
          frontmatter={frontmatter}
          readingMinutes={1}
        />
      );
    });

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).not.toContain('Unsafe Docs');
    expect(container.textContent).not.toContain('参考资料');
  });
});
