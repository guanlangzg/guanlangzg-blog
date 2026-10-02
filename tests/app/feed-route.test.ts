import { describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/feed.xml/route';
import { readSiteSettingsFromDiskAsync } from '@/lib/editor-data-storage';
import { getPostsAsync } from '@/lib/markdown';
import { getSiteUrl } from '@/lib/site-url';
import type { PostMeta } from '@/lib/markdown';

vi.mock('@/lib/editor-data-storage', () => ({
  readSiteSettingsFromDiskAsync: vi.fn(),
}));

vi.mock('@/lib/markdown', () => ({
  getPostsAsync: vi.fn(),
}));

vi.mock('@/lib/site-url', () => ({
  getSiteUrl: vi.fn(),
}));

const mockedReadSiteSettingsFromDiskAsync = vi.mocked(readSiteSettingsFromDiskAsync);
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

describe('RSS feed route', () => {
  it('renders public posts as escaped RSS XML', async () => {
    mockedReadSiteSettingsFromDiskAsync.mockResolvedValue({
      siteName: 'Dev & Notes',
      siteDescription: 'Engineering <notes>',
      workspaceLabel: 'workspace',
      heroTitleLineOne: 'line one',
      heroTitleLineTwo: 'line two',
      heroDescription: 'description',
      introCardEyebrow: 'eyebrow',
      introCardTitle: 'title',
      introCardDescription: 'description',
      introCardMetaOneLabel: 'one',
      introCardMetaOneValue: '1',
      introCardMetaTwoLabel: 'two',
      introCardMetaTwoValue: '2',
      introCardMetaThreeLabel: 'three',
      introCardMetaThreeValue: '3',
      introCardStartLabel: 'start',
      showIntroCard: true,
    });
    mockedGetPostsAsync.mockResolvedValue([
      createPost({
        slug: 'public-post',
        slugArray: ['public-post'],
        title: 'Public & Useful',
        description: 'Readable <summary>',
        tags: ['rss', 'next'],
      }),
      createPost({
        slug: 'navigation',
        slugArray: ['navigation'],
        title: 'Navigation Index',
      }),
    ]);
    mockedGetSiteUrl.mockReturnValue(new URL('https://example.com'));

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain('<title>Dev &amp; Notes</title>');
    expect(body).toContain('<description>Engineering &lt;notes&gt;</description>');
    expect(body).toContain('<title>Public &amp; Useful</title>');
    expect(body).toContain('<description>Readable &lt;summary&gt;</description>');
    expect(body).toContain('<link>https://example.com/posts/public-post</link>');
    expect(body).toContain('<category>rss</category>');
    expect(body).not.toContain('Navigation Index');
  });
});
