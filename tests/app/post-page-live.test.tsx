import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostPage from '@/app/posts/[...slug]/page';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { PublicLiveSnapshot } from '@/lib/live-public-reader';

vi.mock('@/lib/live-public-reader', () => ({
  isLiveReaderRuntime: vi.fn(() => true),
  getPublicLiveSnapshot: vi.fn(),
}));

vi.mock('@/lib/site-url', () => ({
  createOgImagePath: ({ title }: { title: string }) => `/og?title=${encodeURIComponent(title)}`,
  createCanonicalUrl: (pathname: string) => new URL(pathname, 'https://example.com').toString(),
  getSiteUrl: () => new URL('https://example.com'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/image', () => ({
  default: ({ alt = '' }: { alt?: string }) => <span aria-label={alt} />,
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
        // The release is public, but its editorial classification is not.
        status: 'seedling',
        kind: 'essay',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'related-article',
        slug: 'related-article',
        title: `${marker} related`,
        date: '2026-10-04',
        description: '',
        tags: ['shared-topic'],
        content: 'related body',
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

describe('public live post page', () => {
  it('renders body, related posts and settings from the one live snapshot it reads', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha', 'beta', 'gamma']);

    const html = renderToStaticMarkup(
      await PostPage({ params: Promise.resolve({ slug: ['live-article'] }) })
    );

    expect(mockedGetPublicLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(html).toContain('alpha article');
    expect(html).toContain('alpha body');
    expect(html).toContain('alpha related');
    expect(html).toContain('alpha site');
    expect(html).not.toContain('beta');
    expect(html).not.toContain('gamma');
  });

  it('does not expose the editorial lifecycle status of a live article', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha']);

    const html = renderToStaticMarkup(
      await PostPage({ params: Promise.resolve({ slug: ['live-article'] }) })
    );

    expect(html).toContain('alpha article');
    expect(html).not.toContain('幼苗');
    expect(html).not.toContain('草稿');
    expect(html).not.toContain('常青');
  });
});
