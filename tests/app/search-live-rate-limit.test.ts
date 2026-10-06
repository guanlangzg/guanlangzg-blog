import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/search/route';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { resetSearchRateLimitForTests } from '@/lib/search-rate-limit';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { PublicLiveSnapshot } from '@/lib/live-public-reader';

vi.mock('@/lib/live-public-reader', () => ({
  isLiveReaderRuntime: vi.fn(() => true),
  getPublicLiveSnapshot: vi.fn(),
}));

const mockedIsLiveReaderRuntime = vi.mocked(isLiveReaderRuntime);
const mockedGetPublicLiveSnapshot = vi.mocked(getPublicLiveSnapshot);
const ORIGINAL_TRUSTED_PROXY_IPS = process.env.TRUSTED_PROXY_IPS;

function createLiveSnapshot(): PublicLiveSnapshot {
  return {
    releaseId: 'live-release-rate-limit',
    articles: [
      {
        id: 'live-article',
        slug: 'live-article',
        title: 'Release Only',
        date: '2026-10-05',
        description: 'Public release text',
        tags: ['live'],
        content: 'release-token',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS },
    media: [],
  };
}

function createAnonymousRequest(forwardedFor: string): NextRequest {
  return new NextRequest('http://localhost/api/search?q=release-token', {
    headers: { 'X-Forwarded-For': forwardedFor },
  });
}

beforeEach(() => {
  mockedIsLiveReaderRuntime.mockReturnValue(true);
  mockedGetPublicLiveSnapshot.mockReturnValue(createLiveSnapshot());
  // A wildcard proxy configuration is the spoofable case: every request may claim a brand new
  // client identity, so a per-client bucket alone cannot bound the endpoint.
  process.env.TRUSTED_PROXY_IPS = '*';
  resetSearchRateLimitForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  resetSearchRateLimitForTests();

  if (ORIGINAL_TRUSTED_PROXY_IPS === undefined) {
    delete process.env.TRUSTED_PROXY_IPS;
  } else {
    process.env.TRUSTED_PROXY_IPS = ORIGINAL_TRUSTED_PROXY_IPS;
  }
});

describe('anonymous live search resource budget', () => {
  it('bounds total scans even when a spoofable proxy config lets callers rotate X-Forwarded-For', async () => {
    const statuses: number[] = [];

    for (let index = 0; index < 400; index += 1) {
      const response = await GET(createAnonymousRequest(`198.51.100.${index % 250}`));
      statuses.push(response.status);
    }

    const rejected = statuses.filter((status) => status === 429);

    expect(statuses[0]).toBe(200);
    expect(rejected.length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe(429);
    expect(await (await GET(createAnonymousRequest('203.0.113.250'))).json()).toEqual(
      expect.objectContaining({ message: expect.stringContaining('搜索请求过于频繁') })
    );
  });
});
