import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/search/route';
import { getSearchablePostsAsync } from '@/lib/markdown';
import { readNavigationFromDiskAsync } from '@/lib/editor-data-storage';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { resetSearchRateLimitForTests } from '@/lib/search-rate-limit';

vi.mock('@/lib/markdown', () => ({ getSearchablePostsAsync: vi.fn() }));
vi.mock('@/lib/editor-data-storage', () => ({ readNavigationFromDiskAsync: vi.fn() }));
vi.mock('@/lib/editor-api-auth', () => ({ ensureEditorSession: vi.fn(async () => null) }));
vi.mock('@/lib/search-rate-limit', () => ({
  getSearchRateLimitResponse: vi.fn(() => null),
  getAnonymousSearchBudgetResponse: vi.fn(() => null),
  resetSearchRateLimitForTests: vi.fn(),
}));
vi.mock('@/lib/live-public-reader', () => ({
  isLiveReaderRuntime: vi.fn(() => true),
  getPublicLiveSnapshot: vi.fn(),
}));

const mockGetSearchablePosts = vi.mocked(getSearchablePostsAsync);
const mockReadNavigation = vi.mocked(readNavigationFromDiskAsync);
const mockGetPublicLiveSnapshot = vi.mocked(getPublicLiveSnapshot);
const mockIsLive = vi.mocked(isLiveReaderRuntime);

function createPublicLiveSnapshot() {
  return {
    releaseId: 'live-release-1',
    articles: [{
      id: 'live-article', slug: 'live-article', title: 'Release Only', date: '2026-10-05',
      description: 'Public release text', tags: ['live'], content: 'release-token', createdAt: 1, updatedAt: 1,
    }],
    navigation: [{
      name: 'Live links', icon: 'link', slug: 'live-links',
      tools: [{ icon: 'link', title: 'Live tool', description: 'release navigation', url: 'https://live.example', tags: ['live'] }],
    }],
    settings: { ...DEFAULT_SITE_SETTINGS },
    media: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  resetSearchRateLimitForTests();
});

describe('public live search route', () => {
  it('searches only the same live snapshot and does not read mutable navigation or article data', async () => {
    mockIsLive.mockReturnValue(true);
    mockGetPublicLiveSnapshot.mockReturnValue(createPublicLiveSnapshot());
    mockGetSearchablePosts.mockResolvedValue([{
      meta: {
        slug: 'draft-secret', slugArray: ['draft-secret'], title: 'Draft Secret', date: '2026-10-05',
        description: '', tags: [], kind: 'essay', status: 'published', featured: false, readingMinutes: 1,
        sourceLinks: [], revisionNotes: [],
      },
      content: 'private-only-token',
    }]);
    mockReadNavigation.mockResolvedValue([{
      name: 'Draft links', icon: 'link', slug: 'draft-links',
      tools: [{ icon: 'link', title: 'Draft tool', description: '', url: 'https://draft.example', tags: [] }],
    }]);

    const response = await GET(new NextRequest('http://localhost/api/search?q=release-token'));
    const results = await response.json();

    expect(response.status).toBe(200);
    expect(results).toEqual([expect.objectContaining({ title: 'Release Only', href: '/posts/live-article' })]);
    expect(mockGetSearchablePosts).not.toHaveBeenCalled();
    expect(mockReadNavigation).not.toHaveBeenCalled();
  });

  it('returns no content when no release is live', async () => {
    mockIsLive.mockReturnValue(true);
    mockGetPublicLiveSnapshot.mockReturnValue({
      releaseId: null, articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS }, media: [],
    });

    const response = await GET(new NextRequest('http://localhost/api/search?q=release-token'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(mockGetSearchablePosts).not.toHaveBeenCalled();
    expect(mockReadNavigation).not.toHaveBeenCalled();
  });
});
