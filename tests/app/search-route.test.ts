import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/search/route';
import { readNavigationFromDiskAsync } from '@/lib/editor-data-storage';
import { getSearchablePostsAsync } from '@/lib/markdown';
import { resetAppRuntimeConfigCacheForTests } from '@/lib/app-runtime-config';
import { EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';
import {
  createRuntimeEditorSession,
  resetEnvironmentEditorSessionForTests,
} from '@/lib/editor-auth-runtime';
import { resetSearchRateLimitForTests } from '@/lib/search-rate-limit';
import type { PostMeta, SearchablePost } from '@/lib/markdown';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/markdown', () => ({
  getSearchablePostsAsync: vi.fn(),
}));

vi.mock('@/lib/editor-data-storage', () => ({
  readNavigationFromDiskAsync: vi.fn(),
}));

const mockedGetSearchablePostsAsync = vi.mocked(getSearchablePostsAsync);
const mockedReadNavigationFromDiskAsync = vi.mocked(readNavigationFromDiskAsync);
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  SKIP_IP_VALIDATION: process.env.SKIP_IP_VALIDATION,
};
const tempDirectories: string[] = [];
let sessionCookie = '';

function createRequest(query: string, headers?: HeadersInit): NextRequest {
  const requestHeaders = new Headers(headers);

  requestHeaders.set('Cookie', `${EDITOR_SESSION_COOKIE}=${sessionCookie}`);

  return new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(query)}`, {
    headers: requestHeaders,
  });
}

function createAnonymousRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(query)}`);
}

function createPost(partial: Partial<PostMeta> & Pick<PostMeta, 'slug' | 'slugArray' | 'title'>): PostMeta {
  return {
    date: '2026-05-24',
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

function createSearchablePost(
  partial: Partial<PostMeta> & Pick<PostMeta, 'slug' | 'slugArray' | 'title'>,
  content = ''
): SearchablePost {
  return {
    meta: createPost(partial),
    content,
  };
}

beforeEach(async () => {
  for (const name of Object.keys(ORIGINAL_ENV) as Array<Exclude<keyof typeof ORIGINAL_ENV, 'NODE_ENV'>>) {
    const value = ORIGINAL_ENV[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  process.env.BLOG_DATA_ROOT = createTempDirectory('blog-navigation-search-route-');
  tempDirectories.push(process.env.BLOG_DATA_ROOT);
  // This endpoint searches the working copy, so every scenario below runs as a signed-in
  // admin; the anonymous case asserts that no data is read at all.
  process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
  resetEnvironmentEditorSessionForTests();
  sessionCookie = (await createRuntimeEditorSession()) ?? '';
  resetSearchRateLimitForTests();
  resetAppRuntimeConfigCacheForTests();
  mockedGetSearchablePostsAsync.mockReset();
  mockedReadNavigationFromDiskAsync.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv(ORIGINAL_ENV);
  resetEnvironmentEditorSessionForTests();
  resetSearchRateLimitForTests();
  resetAppRuntimeConfigCacheForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('search API', () => {
  it('refuses anonymous queries before reading any working-copy data', async () => {
    const response = await GET(createAnonymousRequest('runtime'));

    expect(response.status).toBe(401);
    expect(mockedGetSearchablePostsAsync).not.toHaveBeenCalled();
    expect(mockedReadNavigationFromDiskAsync).not.toHaveBeenCalled();
  });

  it('refuses a forged session cookie', async () => {
    const response = await GET(new NextRequest('http://localhost/api/search?q=runtime', {
      headers: { Cookie: `${EDITOR_SESSION_COOKIE}=forged-session-value` },
    }));

    expect(response.status).toBe(401);
    expect(mockedGetSearchablePostsAsync).not.toHaveBeenCalled();
  });

  it('returns an empty result without scanning data for empty or short queries', async () => {
    const emptyResponse = await GET(createRequest('   '));
    const shortResponse = await GET(createRequest('n'));

    expect(await emptyResponse.json()).toEqual([]);
    expect(await shortResponse.json()).toEqual([]);
    expect(mockedGetSearchablePostsAsync).not.toHaveBeenCalled();
    expect(mockedReadNavigationFromDiskAsync).not.toHaveBeenCalled();
  });

  it('normalizes case and whitespace when matching post results', async () => {
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'next-runtime-data',
        slugArray: ['next-runtime-data'],
        title: 'Next Runtime Data',
        date: '2026-05-24',
        description: 'Runtime data guide',
      }),
      createSearchablePost({
        slug: 'navigation',
        slugArray: ['navigation'],
        title: 'Navigation Index',
        date: '2026-05-23',
        description: 'Filtered system page',
      }),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    const response = await GET(createRequest('  NEXT   runtime  '));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual([
      expect.objectContaining({
        type: 'post',
        title: 'Next Runtime Data',
        href: '/posts/next-runtime-data',
        external: false,
      }),
    ]);
  });

  it('matches post body content without exposing system pages', async () => {
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'runtime-notes',
        slugArray: ['runtime-notes'],
        title: 'Runtime Notes',
        description: 'No direct query in metadata',
      }, 'This article explains container snapshot recovery for operators.'),
      createSearchablePost({
        slug: 'navigation',
        slugArray: ['navigation'],
        title: 'Navigation Index',
      }, 'snapshot recovery should not expose the system page'),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    const response = await GET(createRequest('snapshot recovery'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual([
      expect.objectContaining({
        type: 'post',
        title: 'Runtime Notes',
        href: '/posts/runtime-notes',
      }),
    ]);
  });

  it('returns tool matches and caps the combined result count', async () => {
    mockedGetSearchablePostsAsync.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => createSearchablePost({
        slug: `search-post-${index}`,
        slugArray: [`search-post-${index}`],
        title: `Search Post ${index}`,
        date: '2026-05-24',
        description: 'Search result',
      }))
    );
    mockedReadNavigationFromDiskAsync.mockResolvedValue([
      {
        name: 'Search Tools',
        icon: 'search',
        slug: 'search-tools',
        tools: Array.from({ length: 6 }, (_, index) => ({
          icon: 'link',
          title: `Search Tool ${index}`,
          description: 'Search result tool',
          url: `https://example.com/tool-${index}`,
          tags: ['search'],
        })),
      },
    ]);

    const response = await GET(createRequest('search'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toHaveLength(8);
    expect(payload.filter((result: { type: string }) => result.type === 'post')).toHaveLength(5);
    expect(payload.filter((result: { type: string }) => result.type === 'tool')).toHaveLength(3);
    expect(payload.at(-1)).toEqual(
      expect.objectContaining({
        type: 'tool',
        external: true,
        meta: 'Search Tools',
      })
    );
  });

  it('caps fallback tool documents and warns when navigation exceeds the limit', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockedGetSearchablePostsAsync.mockResolvedValue([]);
      // The first FALLBACK_MAX_TOOLS tools do not match the query; the only
      // matching tool sits at index FALLBACK_MAX_TOOLS, which gets truncated
      // by the fallback cap, so no tool results should be returned.
      mockedReadNavigationFromDiskAsync.mockResolvedValue([
        {
          name: 'Other Tools',
          icon: 'link',
          slug: 'other-tools',
          tools: Array.from({ length: 1000 }, (_, index) => ({
            icon: 'link',
            title: `Other Tool ${index}`,
            description: 'Unrelated description',
            url: `https://example.com/other-${index}`,
            tags: ['other'],
          })),
        },
        {
          name: 'Search Tools',
          icon: 'search',
          slug: 'search-tools',
          tools: [
            {
              icon: 'link',
              title: 'Search Target',
              description: 'Should be capped out',
              url: 'https://example.com/search-target',
              tags: ['search'],
            },
          ],
        },
      ]);

      const response = await GET(createRequest('search'));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Fallback path scanned 1001 tools; capping to 1000')
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('rate limits search scans per client IP', async () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'search-post',
        slugArray: ['search-post'],
        title: 'Search Post',
      }),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    for (let index = 0; index < 30; index += 1) {
      const response = await GET(createRequest('search', {
        'X-Forwarded-For': '198.51.100.10, 203.0.113.1',
      }));
      expect(response.status).toBe(200);
    }

    const blockedResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.10, 203.0.113.1',
    }));
    const otherClientResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.200, 203.0.113.1',
    }));

    expect(blockedResponse.status).toBe(429);
    expect(await blockedResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('搜索请求过于频繁'),
      })
    );
    expect(otherClientResponse.status).toBe(200);
  });

  it('isolates search rate limiting for a single forwarded IP recorded by the trusted proxy', async () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'search-post',
        slugArray: ['search-post'],
        title: 'Search Post',
      }),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    for (let index = 0; index < 30; index += 1) {
      const response = await GET(createRequest('search', {
        'X-Forwarded-For': '198.51.100.10',
      }));
      expect(response.status).toBe(200);
    }

    const blockedResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.10',
    }));
    const otherClientResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.200',
    }));

    expect(blockedResponse.status).toBe(429);
    expect(otherClientResponse.status).toBe(200);
  });

  it('rate limits search scans with a single forwarded client IP only when proxy trust is wildcard', async () => {
    process.env.TRUSTED_PROXY_IPS = '*';
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'search-post',
        slugArray: ['search-post'],
        title: 'Search Post',
      }),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    for (let index = 0; index < 30; index += 1) {
      const response = await GET(createRequest('search', {
        'X-Forwarded-For': '198.51.100.10',
      }));
      expect(response.status).toBe(200);
    }

    const blockedResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.10',
    }));
    const otherClientResponse = await GET(createRequest('search', {
      'X-Forwarded-For': '198.51.100.200',
    }));

    expect(blockedResponse.status).toBe(429);
    expect(otherClientResponse.status).toBe(200);
  });

  it('requires trusted proxy configuration for search rate limiting in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.SKIP_IP_VALIDATION;
    mockedGetSearchablePostsAsync.mockResolvedValue([
      createSearchablePost({
        slug: 'search-post',
        slugArray: ['search-post'],
        title: 'Search Post',
      }),
    ]);
    mockedReadNavigationFromDiskAsync.mockResolvedValue([]);

    const response = await GET(createRequest('search'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('TRUSTED_PROXY_IPS'),
      })
    );
    expect(mockedGetSearchablePostsAsync).not.toHaveBeenCalled();
    expect(mockedReadNavigationFromDiskAsync).not.toHaveBeenCalled();
  });
});
