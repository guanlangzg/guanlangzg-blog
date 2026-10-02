import { describe, expect, it, vi } from 'vitest';
import {
  generateMetadata,
  generateStaticParams,
} from '@/app/posts/[...slug]/page';
import type { PostMeta } from '@/lib/markdown';

const posts: PostMeta[] = [
  {
    slug: 'hello-world',
    slugArray: ['hello-world'],
    title: 'Hello World',
    date: '2026-05-25',
    description: 'Article description',
    updatedDate: '2026-05-26',
    tags: ['nextjs', 'seo'],
    kind: 'guide',
    status: 'published',
    category: 'Engineering',
    series: 'Launch',
    featured: false,
    readingMinutes: 4,
    sourceLinks: [],
    revisionNotes: [],
  },
  {
    slug: 'nested/article',
    slugArray: ['nested', 'article'],
    title: 'Nested Article',
    date: '2026-05-27',
    description: 'Nested description',
    tags: [],
    kind: 'essay',
    status: 'published',
    featured: false,
    readingMinutes: 2,
    sourceLinks: [],
    revisionNotes: [],
  },
];

vi.mock('@/lib/markdown', () => ({
  getPostsAsync: async () => posts,
  getPostBySlugArrayAsync: async (slug: string[]) => {
    const post = posts.find((candidate) => candidate.slugArray.join('/') === slug.join('/'));

    return post ? { meta: post, content: '# Article' } : null;
  },
  getRelatedPostsAsync: async () => [],
}));

vi.mock('@/lib/site-url', () => ({
  createOgImagePath: ({ title }: { title: string }) => `/og?title=${encodeURIComponent(title)}`,
  getSiteUrl: () => new URL('https://example.com'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));

describe('PostPage metadata', () => {
  it('generates static params for public post slugs', async () => {
    await expect(generateStaticParams()).resolves.toEqual([
      { slug: ['hello-world'] },
      { slug: ['nested', 'article'] },
    ]);
  });

  it('adds canonical article metadata from the site URL', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: ['hello-world'] }),
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        title: 'Hello World',
        description: 'Article description',
        alternates: {
          canonical: 'https://example.com/posts/hello-world',
        },
        openGraph: expect.objectContaining({
          type: 'article',
          publishedTime: '2026-05-25',
          modifiedTime: '2026-05-26',
          tags: ['nextjs', 'seo'],
        }),
      })
    );
  });

  it('returns not-found metadata for missing posts', async () => {
    await expect(generateMetadata({
      params: Promise.resolve({ slug: ['missing'] }),
    })).resolves.toEqual({ title: '文章未找到' });
  });
});
