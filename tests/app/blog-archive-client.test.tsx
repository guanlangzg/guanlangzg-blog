import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlogArchiveClient } from '@/app/blog/BlogArchiveClient';
import type { PostMeta } from '@/lib/markdown';

const navigationMock = vi.hoisted(() => ({
  params: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigationMock.params,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const posts: PostMeta[] = [
  {
    title: 'First Article',
    description: 'First description',
    date: '2026-05-25',
    slug: 'first-article',
    slugArray: ['first-article'],
    kind: 'essay',
    status: 'published',
    category: 'Engineering',
    tags: ['nextjs'],
    featured: false,
    readingMinutes: 3,
    sourceLinks: [],
    revisionNotes: [],
  },
];

describe('BlogArchiveClient', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navigationMock.params = new URLSearchParams();
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

  it('renders archive filters with mobile touch and keyboard focus affordances', () => {
    act(() => {
      root.render(<BlogArchiveClient posts={posts} />);
    });

    expect(container.textContent).toContain('全部类型');
    expect(container.textContent).toContain('全部分类');
    expect(container.textContent).toContain('共 1 篇');
    expect(container.innerHTML).toContain('min-h-[44px]');
    expect(container.innerHTML).toContain('focus-visible:outline-2');
    expect(container.innerHTML).toContain('focus-visible:outline-focus');
  });

  it('filters posts from URL search params on the client', () => {
    navigationMock.params = new URLSearchParams('kind=guide');

    act(() => {
      root.render(<BlogArchiveClient posts={posts} />);
    });

    expect(container.textContent).toContain('共 0 篇（已筛选）');
    expect(container.textContent).toContain('暂无文章');
  });
});
