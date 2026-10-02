import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import BlogPage from '@/app/blog/page';

vi.mock('@/lib/markdown', () => ({
  getPostsAsync: async () => [
    {
      title: 'First Article',
      description: 'First description',
      date: '2026-05-25',
      slug: 'first-article',
      slugArray: ['first-article'],
      kind: 'essay',
      category: 'Engineering',
      tags: ['nextjs'],
      readingMinutes: 3,
      featured: false,
    },
  ],
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('BlogPage', () => {
  it('renders the static archive shell without reading request search params', async () => {
    const html = renderToStaticMarkup(await BlogPage());

    expect(html).toContain('文章归档');
    expect(html).toContain('1 posts');
    expect(html).toContain('1 年归档');
    expect(html).toContain('加载归档...');
  });
});
