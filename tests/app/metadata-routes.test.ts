import { beforeEach, describe, expect, it, vi } from 'vitest';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import { GET as getOgImage } from '@/app/og/route';
import { getPostsAsync } from '@/lib/markdown';
import { getSiteUrl } from '@/lib/site-url';
import type { PostMeta } from '@/lib/markdown';

const imageResponseState = vi.hoisted(() => ({
  element: null as unknown,
  init: null as unknown,
}));

vi.mock('@/lib/markdown', () => ({
  getPostsAsync: vi.fn(),
}));

vi.mock('@/lib/site-url', () => ({
  getSiteUrl: vi.fn(),
}));

vi.mock('next/og', () => ({
  ImageResponse: class extends Response {
    constructor(element: unknown, init: unknown) {
      imageResponseState.element = element;
      imageResponseState.init = init;
      super('mock image', {
        headers: {
          'Content-Type': 'image/png',
        },
      });
    }
  },
}));

const mockedGetPostsAsync = vi.mocked(getPostsAsync);
const mockedGetSiteUrl = vi.mocked(getSiteUrl);

function createPost(partial: Partial<PostMeta> & Pick<PostMeta, 'slug' | 'slugArray' | 'title'>): PostMeta {
  return {
    date: '2026-06-01',
    description: '',
    tags: [],
    kind: 'essay',
    status: 'published',
    featured: false,
    readingMinutes: 1,
    sourceLinks: [],
    revisionNotes: [],
    ...partial,
  };
}

function collectText(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectText);
  }

  if (value && typeof value === 'object' && 'props' in value) {
    return collectText((value as { props?: { children?: unknown } }).props?.children);
  }

  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  imageResponseState.element = null;
  imageResponseState.init = null;
  mockedGetSiteUrl.mockReturnValue(new URL('https://example.com'));
});

describe('metadata routes', () => {
  it('generates sitemap entries for static pages and public posts', async () => {
    mockedGetPostsAsync.mockResolvedValue([
      createPost({
        slug: 'public-post',
        slugArray: ['public-post'],
        title: 'Public Post',
        updatedDate: '2026-06-02',
        featured: true,
      }),
      createPost({
        slug: 'navigation',
        slugArray: ['navigation'],
        title: 'Navigation Index',
      }),
    ]);

    const entries = await sitemap();

    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/blog',
      'https://example.com/navigation',
      'https://example.com/posts/public-post',
    ]);
    expect(entries.find((entry) => entry.url.endsWith('/posts/public-post'))).toEqual(
      expect.objectContaining({
        lastModified: '2026-06-02',
        changeFrequency: 'monthly',
        priority: 0.8,
      })
    );
    expect(entries.some((entry) => entry.url.endsWith('/posts/navigation'))).toBe(false);
  });

  it('keeps editor routes out of robots while linking the sitemap', () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: '*',
        allow: '/',
        disallow: '/editor',
      },
      sitemap: 'https://example.com/sitemap.xml',
    });
  });

  it('renders an OG image response with fallback text', () => {
    const response = getOgImage(new Request('https://example.com/og'));
    const text = collectText(imageResponseState.element);

    expect(response.headers.get('Content-Type')).toContain('image/png');
    expect(imageResponseState.init).toEqual({ width: 1200, height: 630 });
    expect(text).toContain('观澜志');
    expect(text).toContain('记录值得回看的文章与实用导航。');
  });

  it('limits long OG image text parameters', () => {
    getOgImage(new Request(`https://example.com/og?title=${'A'.repeat(90)}&description=${'B'.repeat(140)}`));
    const text = collectText(imageResponseState.element);
    const title = text.find((item) => item.startsWith('A'));
    const description = text.find((item) => item.startsWith('B'));

    expect(title).toHaveLength(72);
    expect(title?.endsWith('...')).toBe(true);
    expect(description).toHaveLength(108);
    expect(description?.endsWith('...')).toBe(true);
  });
});
