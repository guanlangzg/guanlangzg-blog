import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as getFeed } from '@/app/feed.xml/route';
import sitemap, { dynamic as sitemapDynamic } from '@/app/sitemap';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { PublicLiveSnapshot } from '@/lib/live-public-reader';

vi.mock('@/lib/live-public-reader', () => ({
  isLiveReaderRuntime: vi.fn(() => true),
  getPublicLiveSnapshot: vi.fn(),
}));

vi.mock('@/lib/site-url', () => ({
  getSiteUrl: () => new URL('https://example.com'),
  createCanonicalUrl: (pathname: string) => new URL(pathname, 'https://example.com').toString(),
  createOgImagePath: ({ title }: { title: string }) => `/og?title=${encodeURIComponent(title)}`,
}));

const mockedIsLiveReaderRuntime = vi.mocked(isLiveReaderRuntime);
const mockedGetPublicLiveSnapshot = vi.mocked(getPublicLiveSnapshot);

function createLiveSnapshot(marker: string): PublicLiveSnapshot {
  return {
    releaseId: `release-${marker}`,
    articles: [
      {
        id: 'live-article',
        slug: 'live-article',
        title: `${marker} article`,
        date: '2026-10-05',
        description: `${marker} description`,
        tags: ['shared-topic'],
        content: `${marker} body`,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS, siteName: `${marker} site` },
    media: [],
  };
}

function useSwitchingSnapshots(markers: string[]): void {
  let callIndex = 0;

  mockedGetPublicLiveSnapshot.mockImplementation(() => {
    const snapshot = createLiveSnapshot(markers[Math.min(callIndex, markers.length - 1)]);
    callIndex += 1;
    return snapshot;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('live reader feed and sitemap', () => {
  it('builds the RSS feed from the one live snapshot it reads', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha', 'beta']);

    const response = await getFeed();
    const body = await response.text();

    expect(mockedGetPublicLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(body).toContain('alpha site');
    expect(body).toContain('alpha article');
    expect(body).not.toContain('beta');
  });

  it('builds the sitemap from the live release instead of a cached generation', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha', 'beta']);

    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);

    expect(mockedGetPublicLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(sitemapDynamic).toBe('force-dynamic');
    expect(urls).toContain('https://example.com/posts/live-article');
  });

  it('does not leak a stale release into a later sitemap request', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha', 'beta']);

    await sitemap();
    mockedGetPublicLiveSnapshot.mockClear();
    useSwitchingSnapshots(['beta']);

    const entries = await sitemap();
    const searchable = JSON.stringify(entries);

    expect(mockedGetPublicLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(searchable).not.toContain('alpha');
  });
});
