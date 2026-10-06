import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { PublicLiveSnapshot } from '@/lib/live-public-reader';

vi.mock('@/lib/live-public-reader', () => ({
  isLiveReaderRuntime: vi.fn(() => true),
  getPublicLiveSnapshot: vi.fn(),
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
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigation: [
      {
        name: `${marker} group`,
        icon: 'link',
        slug: `${marker}-group`,
        tools: [{
          icon: 'link',
          title: `${marker} tool`,
          description: `${marker} tool description`,
          url: `https://${marker}.example`,
          tags: [],
        }],
      },
    ],
    settings: {
      ...DEFAULT_SITE_SETTINGS,
      siteName: `${marker} site`,
      workspaceLabel: `${marker} workspace`,
    },
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

describe('public live home page', () => {
  it('renders posts, navigation and settings from the one live snapshot it reads', async () => {
    mockedIsLiveReaderRuntime.mockReturnValue(true);
    useSwitchingSnapshots(['alpha', 'beta']);

    const html = renderToStaticMarkup(await Home());

    expect(mockedGetPublicLiveSnapshot).toHaveBeenCalledTimes(1);
    expect(html).toContain('alpha article');
    expect(html).toContain('alpha tool');
    expect(html).toContain('alpha workspace');
    expect(html).not.toContain('beta');
  });
});
