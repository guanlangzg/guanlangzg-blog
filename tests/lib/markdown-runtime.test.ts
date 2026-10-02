import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '@/app/types/article';

const ORIGINAL_BLOG_DATA_ROOT = process.env.BLOG_DATA_ROOT;
const tempDirectories: string[] = [];

function createTempDataRoot(articles?: Article[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-'));
  tempDirectories.push(root);

  if (articles) {
    const articlesDir = path.join(root, 'articles');
    fs.mkdirSync(articlesDir, { recursive: true });
    fs.writeFileSync(
      path.join(articlesDir, 'articles.json'),
      JSON.stringify(articles, null, 2),
      'utf8'
    );
  }

  return root;
}

function createArticle(id: string, title: string): Article {
  return {
    id,
    title,
    date: '2026-03-09',
    description: `${title} description`,
    tags: ['runtime'],
    content: `# ${title}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

async function importMarkdownModule() {
  vi.resetModules();
  return import('@/lib/markdown');
}

afterEach(() => {
  vi.resetModules();

  if (ORIGINAL_BLOG_DATA_ROOT === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = ORIGINAL_BLOG_DATA_ROOT;
  }

  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('markdown runtime article source', () => {
  it('reads public posts from BLOG_DATA_ROOT article data when configured', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'runtime-article-001',
        title: 'Runtime Article',
        date: '2026-03-09',
        description: 'Loaded from mapped docker data',
        tags: ['docker'],
        content: '# Runtime Article',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const { getPosts } = await importMarkdownModule();

    expect(getPosts()).toEqual([
      expect.objectContaining({
        title: 'Runtime Article',
        date: '2026-03-09',
        description: 'Loaded from mapped docker data',
      }),
    ]);
  });

  it('falls back to seed posts when BLOG_DATA_ROOT is configured but no articles file exists', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const { getPosts } = await importMarkdownModule();
    const posts = getPosts();

    expect(posts.length).toBeGreaterThan(0);
    expect(posts.some((p) => p.title === '从这里开始读这本公开笔记')).toBe(true);
  });

  it('does not fall back to seed posts when runtime articles are valid but empty', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([]);

    const { getPostBySlugArray, getPosts } = await importMarkdownModule();

    expect(getPosts()).toEqual([]);
    expect(getPostBySlugArray(['2026-05-25-getting-started'])).toBeNull();
  });

  it('invalidates seed post cache after runtime writes create article data', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;

    const { getPosts } = await importMarkdownModule();
    const { writeArticlesToDisk } = await import('@/lib/editor-data-storage');

    expect(getPosts().some((post) => post.title === 'Runtime After Seed Cache')).toBe(false);

    await writeArticlesToDisk([
      createArticle('runtime-after-seed-cache', 'Runtime After Seed Cache'),
    ]);

    expect(getPosts()).toEqual([
      expect.objectContaining({
        title: 'Runtime After Seed Cache',
      }),
    ]);
  });

  it('loads article detail content from BLOG_DATA_ROOT article data', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'runtime-article-002',
        title: 'Docker Managed Post',
        date: '2026-03-08',
        description: 'Public content comes from runtime JSON',
        tags: ['runtime'],
        content: '## Runtime content',
        createdAt: 3,
        updatedAt: 4,
      },
    ]);

    const { getPostBySlugArray, getPosts } = await importMarkdownModule();
    const [post] = getPosts();

    expect(post).toBeTruthy();
    expect(getPostBySlugArray(post.slugArray)).toEqual(
      expect.objectContaining({
        content: '## Runtime content',
        meta: expect.objectContaining({
          title: 'Docker Managed Post',
        }),
      })
    );
  });

  it('does not expose draft runtime articles publicly', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'draft-article',
        slug: 'draft-article',
        title: 'Draft Article',
        date: '2026-03-08',
        description: 'Draft content',
        tags: ['draft'],
        content: '## Draft content',
        status: 'draft',
        createdAt: 3,
        updatedAt: 4,
      },
    ]);

    const { getPostBySlugArray, getPosts } = await importMarkdownModule();

    expect(getPosts()).toEqual([]);
    expect(getPosts().some((post) => post.title === 'Draft Article')).toBe(false);
    expect(getPostBySlugArray(['draft-article'])).toBeNull();
  });

  it('does not fall back to seed posts when runtime article data is intentionally empty', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([]);

    const { getPosts } = await importMarkdownModule();

    expect(getPosts()).toEqual([]);
  });

  it('uses stored runtime article slugs instead of deriving URLs from mutable titles', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'runtime-article-003',
        slug: 'stable-runtime-url',
        title: 'Renamed Runtime Post',
        date: '2026-03-07',
        description: 'Public URL should stay stable',
        tags: ['runtime'],
        content: '## Stable content',
        createdAt: 5,
        updatedAt: 6,
      },
    ]);

    const { getPostBySlugArray, getPosts } = await importMarkdownModule();
    const [post] = getPosts();

    expect(post.slug).toBe('stable-runtime-url');
    expect(getPostBySlugArray(['stable-runtime-url'])).toEqual(
      expect.objectContaining({
        content: '## Stable content',
      })
    );
  });

  it('loads runtime posts and details through asynchronous public helpers', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'runtime-article-async',
        slug: 'async-runtime-url',
        title: 'Async Runtime Post',
        date: '2026-03-07',
        description: 'Public async URL should stay stable',
        tags: ['runtime'],
        content: '## Async content',
        createdAt: 5,
        updatedAt: 6,
      },
    ]);

    const { getPostBySlugArrayAsync, getPostsAsync } = await importMarkdownModule();
    const posts = await getPostsAsync();

    expect(posts).toEqual([
      expect.objectContaining({
        slug: 'async-runtime-url',
        title: 'Async Runtime Post',
      }),
    ]);
    await expect(getPostBySlugArrayAsync(['async-runtime-url'])).resolves.toEqual(
      expect.objectContaining({
        content: '## Async content',
      })
    );
  });

  it('returns searchable runtime posts with content for full-text search', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot([
      {
        id: 'runtime-searchable-article',
        slug: 'runtime-searchable-article',
        title: 'Runtime Searchable Article',
        date: '2026-03-07',
        description: 'Search metadata',
        tags: ['runtime'],
        content: '## Searchable body content',
        createdAt: 5,
        updatedAt: 6,
      },
    ]);

    const { getSearchablePostsAsync } = await importMarkdownModule();

    await expect(getSearchablePostsAsync()).resolves.toEqual([
      {
        meta: expect.objectContaining({
          slug: 'runtime-searchable-article',
          title: 'Runtime Searchable Article',
        }),
        content: '## Searchable body content',
      },
    ]);
  });

  it('returns null instead of throwing when a post slug cannot be decoded', async () => {
    delete process.env.BLOG_DATA_ROOT;

    const { getPostBySlugArray } = await importMarkdownModule();

    expect(getPostBySlugArray(['%E0%A4%A'])).toBeNull();
  });
});
