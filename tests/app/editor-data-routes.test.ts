import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getArticles, PATCH as patchArticles, PUT as putArticles } from '@/app/api/data/articles/route';
import { GET as getNavigation, PUT as putNavigation } from '@/app/api/data/navigation/route';
import { GET as getSettings, PUT as putSettings } from '@/app/api/data/settings/route';
import { EDITOR_JSON_BODY_LIMIT_BYTES } from '@/lib/api-json-body';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import { writeArticlesToDisk } from '@/lib/editor-data-storage';
import { EDITOR_CSRF_HEADER } from '@/lib/editor-auth';
import { resetEnvironmentEditorSessionForTests } from '@/lib/editor-auth-runtime';
import { createDefaultSiteSettings } from '@/lib/site-settings';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/editor-remote-backup', () => ({
  queueCurrentBackupToRemote: vi.fn(),
}));

vi.mock('@/lib/public-cache-invalidation', () => ({
  invalidatePublicContentCache: vi.fn(),
}));

const mockedQueueCurrentBackupToRemote = vi.mocked(queueCurrentBackupToRemote);
const mockedInvalidatePublicContentCache = vi.mocked(invalidatePublicContentCache);
const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  BLOG_NAVIGATION_DOCKER: process.env.BLOG_NAVIGATION_DOCKER,
  BLOG_NAVIGATION_VERSION: process.env.BLOG_NAVIGATION_VERSION,
  BLOG_NAVIGATION_IMAGE_TAG: process.env.BLOG_NAVIGATION_IMAGE_TAG,
  BLOG_NAVIGATION_REVISION: process.env.BLOG_NAVIGATION_REVISION,
  BLOG_NAVIGATION_BUILD_TIME: process.env.BLOG_NAVIGATION_BUILD_TIME,
};
const tempDirectories: string[] = [];

function resetEnv(): void {
  restoreEnv(ORIGINAL_ENV);
}

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-editor-data-route-');
  tempDirectories.push(directory);
  return directory;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function createArticle(id: string, title: string) {
  return {
    id,
    title,
    date: '2026-05-24',
    description: `${title} description`,
    tags: ['test'],
    content: `# ${title}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

function createSettings(siteName: string) {
  return {
    siteName,
    siteDescription: `${siteName} description`,
    workspaceLabel: 'workspace / test',
    heroTitleLineOne: 'Hero One',
    heroTitleLineTwo: 'Hero Two',
    heroDescription: 'Hero description',
  };
}

function seedRuntimeData(dataRoot: string): void {
  writeJson(path.join(dataRoot, 'articles', 'articles.json'), [createArticle('article-1', 'First Article')]);
  writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
  writeJson(path.join(dataRoot, 'settings', 'site.json'), createSettings('Original Site'));
}

async function createAuthenticatedHeaders(url: string): Promise<Headers> {
  const currentRoot = process.env.BLOG_DATA_ROOT;

  process.env.BLOG_DATA_ROOT = createTempDataRoot();

  try {
    const request = await createAuthedEditorRequest(url);

    return new Headers(request.headers);
  } finally {
    if (currentRoot === undefined) {
      delete process.env.BLOG_DATA_ROOT;
    } else {
      process.env.BLOG_DATA_ROOT = currentRoot;
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedQueueCurrentBackupToRemote.mockResolvedValue({
    queued: false,
    enabled: false,
    success: false,
    message: 'R2 backup is disabled.',
  });
});

afterEach(() => {
  resetEnv();
  resetEnvironmentEditorSessionForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('editor data write APIs', () => {
  it('rejects authenticated writes without a CSRF header', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const authedRequest = await createAuthedEditorRequest('http://localhost/api/data/articles');
    const headers = new Headers({
      Cookie: authedRequest.headers.get('cookie') ?? '',
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
    });
    const response = await putArticles(new NextRequest('http://localhost/api/data/articles', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: current.revision,
        articles: [createArticle('article-2', 'Rejected Article')],
      }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('校验失败'),
      })
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects authenticated writes from a different origin', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const authedRequest = await createAuthedEditorRequest('http://localhost/api/data/articles');
    const headers = new Headers(authedRequest.headers);

    headers.set('Origin', 'https://attacker.example');
    headers.set('Content-Type', 'application/json');

    const response = await putArticles(new NextRequest('http://localhost/api/data/articles', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: current.revision,
        articles: [createArticle('article-2', 'Rejected Article')],
      }),
    }));

    expect(response.status).toBe(403);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('accepts authenticated writes from the trusted forwarded public origin', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const authedRequest = await createAuthedEditorRequest('http://localhost/api/data/articles');
    const headers = new Headers(authedRequest.headers);

    headers.set('Origin', 'https://public.example.com');
    headers.set('X-Forwarded-Host', 'public.example.com');
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('Content-Type', 'application/json');

    const response = await putArticles(new NextRequest('http://localhost/api/data/articles', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: current.revision,
        articles: [createArticle('article-2', 'Forwarded Origin Article')],
      }),
    }));

    expect(response.status).toBe(200);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledOnce();
  });

  it('rejects a PATCH upsert that duplicates another article slug', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const dataRoot = process.env.BLOG_DATA_ROOT;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [
      { ...createArticle('article-1', 'First Article'), slug: 'shared-post' },
    ]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), createSettings('Original Site'));

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const authedRequest = await createAuthedEditorRequest('http://localhost/api/data/articles');
    const headers = new Headers(authedRequest.headers);
    headers.set('Content-Type', 'application/json');

    const response = await patchArticles(new NextRequest('http://localhost/api/data/articles', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        operation: 'upsert',
        revision: current.revision,
        article: { ...createArticle('article-2', 'Second Article'), slug: 'shared-post' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('文章 slug 重复'),
      })
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
    // Reading the stored articles must still work: a duplicate slug would make
    // every later read path throw and take the whole site down.
    const stored = JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('adds a CSRF header to authenticated test write requests', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const request = await createAuthedEditorRequest('http://localhost/api/data/articles');

    expect(request.headers.get(EDITOR_CSRF_HEADER)).toBeTruthy();
    expect(request.headers.get('origin')).toBe('http://localhost');
  });

  it('reports corrupt article files without returning empty editor data', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    writeText(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), '{');

    const response = await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        message: '服务器运行时数据文件损坏，请修复数据文件后重试。',
        resource: 'articles',
      })
    );
  });

  it('reports invalid navigation files without rewriting seed data', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const navigationPath = path.join(process.env.BLOG_DATA_ROOT, 'navigation', 'tools.json');
    writeJson(navigationPath, { invalid: true });

    const response = await getNavigation(await createAuthedEditorRequest('http://localhost/api/data/navigation'));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        resource: 'navigation',
      })
    );
    expect(JSON.parse(fs.readFileSync(navigationPath, 'utf8'))).toEqual({ invalid: true });
  });

  it('reports invalid settings files without returning default settings', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    writeJson(path.join(process.env.BLOG_DATA_ROOT, 'settings', 'site.json'), {
      siteName: '',
    });

    const response = await getSettings(await createAuthedEditorRequest('http://localhost/api/data/settings'));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        resource: 'settings',
      })
    );
  });

  it('returns project and Docker version metadata with editor settings', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    process.env.BLOG_NAVIGATION_VERSION = '2.0.1';
    process.env.BLOG_NAVIGATION_IMAGE_TAG = 'v2.0.1-build.42';
    process.env.BLOG_NAVIGATION_REVISION = 'abcdef1234567890';
    process.env.BLOG_NAVIGATION_BUILD_TIME = '2026-06-08T08:00:00Z';
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const response = await getSettings(await createAuthedEditorRequest('http://localhost/api/data/settings'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.version).toEqual({
      projectVersion: '2.0.1',
      displayVersion: 'v2.0.1-build.42',
      runtime: 'docker',
      docker: {
        enabled: true,
        imageTag: 'v2.0.1-build.42',
        revision: 'abcdef1234567890',
        buildTime: '2026-06-08T08:00:00Z',
      },
    });
  });

  it('rejects malformed article JSON without writing or remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const existingArticles = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'),
      'utf8'
    );

    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: '{',
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: 'invalid_json',
      })
    );
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8')).toBe(
      existingArticles
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects oversized article write bodies before parsing or remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const existingArticles = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'),
      'utf8'
    );
    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        headers: {
          'Content-Length': String(EDITOR_JSON_BODY_LIMIT_BYTES + 1),
        },
        body: '{}',
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '请求体过大，请缩小数据后重试。',
      })
    );
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8')).toBe(
      existingArticles
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('requires the current revision before writing articles', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          articles: [createArticle('article-2', 'Missing Revision Article')],
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'article-1',
      }),
    ]);
  });

  it('writes articles and triggers remote sync when the revision matches', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          articles: [createArticle('article-2', 'Next Article')],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'articles-write',
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('articles-write');
  });

  it('patches one article without sending the full collection', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const updatedArticle = {
      ...createArticle('article-1', 'Updated Article'),
      slug: 'updated-article',
    };
    const response = await patchArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PATCH',
        body: JSON.stringify({
          operation: 'upsert',
          article: updatedArticle,
          revision: current.revision,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({ id: 'article-1', title: 'Updated Article' }),
    ]);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({ reason: 'articles-patch' });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('articles-patch');
  });

  it('deletes one article through the incremental endpoint', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const response = await patchArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PATCH',
        body: JSON.stringify({ operation: 'delete', id: 'article-1', revision: current.revision }),
      })
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([]);
  });

  it('returns a specific article validation error without writing or remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const existingArticles = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'),
      'utf8'
    );

    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          revision: 'stale-revision',
          articles: [
            {
              ...createArticle('article-2', 'Duplicate One'),
              slug: 'same',
            },
            {
              ...createArticle('article-3', 'Duplicate Two'),
              slug: 'same',
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '文章 slug 重复：same',
      })
    );
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8')).toBe(
      existingArticles
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a structured 503 when the runtime data root path is unavailable for writes', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    const headers = await createAuthenticatedHeaders('http://localhost/api/data/articles');

    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const articleResponse = await putArticles(new NextRequest('http://localhost/api/data/articles', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: 'blocked-root',
        articles: [createArticle('article-blocked', 'Blocked Article')],
      }),
    }));
    const navigationResponse = await putNavigation(new NextRequest('http://localhost/api/data/navigation', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: 'blocked-root',
        categories: [
          {
            name: 'Docs',
            icon: 'book',
            slug: 'docs',
            tools: [],
          },
        ],
      }),
    }));
    const settingsResponse = await putSettings(new NextRequest('http://localhost/api/data/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: 'blocked-root',
        settings: createSettings('Blocked Root Site'),
      }),
    }));

    for (const response of [articleResponse, navigationResponse, settingsResponse]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: 'runtime_data_root_unavailable',
        message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
      });
    }

    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('marks routes non-persistent when the runtime data root path is unavailable for reads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const articleResponse = await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'));
    const navigationResponse = await getNavigation(await createAuthedEditorRequest('http://localhost/api/data/navigation'));
    const settingsResponse = await getSettings(await createAuthedEditorRequest('http://localhost/api/data/settings'));

    expect(articleResponse.status).toBe(200);
    expect(await articleResponse.json()).toEqual({
      persistent: false,
      revision: null,
      articles: [],
    });

    expect(navigationResponse.status).toBe(200);
    expect(await navigationResponse.json()).toEqual({
      persistent: false,
      revision: null,
      categories: [],
    });

    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toEqual(
      expect.objectContaining({
        persistent: false,
        revision: null,
        settings: createDefaultSiteSettings(),
        version: expect.any(Object),
      })
    );
  });

  it('rejects stale article revisions after another committed write', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    await writeArticlesToDisk([createArticle('article-newer', 'Newer Article')]);

    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          articles: [createArticle('article-attempted', 'Attempted Article')],
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(
      expect.objectContaining({
        revision: expect.any(String),
        articles: [
          expect.objectContaining({
            id: 'article-newer',
          }),
        ],
      })
    );
    expect(payload.revision).not.toBe(current.revision);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'article-newer',
      }),
    ]);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects invalid navigation payloads without writing or remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const existingNavigation = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'navigation', 'tools.json'),
      'utf8'
    );

    const response = await putNavigation(
      await createAuthedEditorRequest('http://localhost/api/data/navigation', {
        method: 'PUT',
        body: JSON.stringify({
          categories: [
            {
              name: 'Invalid',
              icon: 'book',
              slug: 'invalid',
              tools: [
                {
                  icon: 'link',
                  title: 'Insecure URL',
                  description: 'Invalid navigation payload',
                  url: 'http://example.com',
                  tags: ['test'],
                },
              ],
            },
          ],
          revision: 'stale-revision',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '导航工具必须包含 icon、title、description 和 HTTPS URL。',
      })
    );
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'navigation', 'tools.json'), 'utf8')).toBe(
      existingNavigation
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('requires the current revision before writing navigation', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const response = await putNavigation(
      await createAuthedEditorRequest('http://localhost/api/data/navigation', {
        method: 'PUT',
        body: JSON.stringify({
          categories: [
            {
              name: 'Docs',
              icon: 'book',
              slug: 'docs',
              tools: [],
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'navigation', 'tools.json'), 'utf8'))).toEqual([]);
  });

  it('writes navigation and triggers remote sync when the revision matches', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getNavigation(await createAuthedEditorRequest('http://localhost/api/data/navigation'))).json();
    const response = await putNavigation(
      await createAuthedEditorRequest('http://localhost/api/data/navigation', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          categories: [
            {
              name: 'Docs',
              icon: 'book',
              slug: 'docs',
              tools: [],
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'navigation-write',
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('navigation-write');
  });

  it('rejects invalid settings payloads without writing or remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const existingSettings = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'settings', 'site.json'),
      'utf8'
    );

    const response = await putSettings(
      await createAuthedEditorRequest('http://localhost/api/data/settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            siteName: '',
          },
          revision: 'stale-revision',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '站点设置必须包含非空的 siteName。',
      })
    );
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'settings', 'site.json'), 'utf8')).toBe(
      existingSettings
    );
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('requires the current revision before writing settings', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const response = await putSettings(
      await createAuthedEditorRequest('http://localhost/api/data/settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: createSettings('Missing Revision Site'),
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'settings', 'site.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        siteName: 'Original Site',
      })
    );
  });

  it('writes settings and triggers remote sync when the revision matches', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);

    const current = await (await getSettings(await createAuthedEditorRequest('http://localhost/api/data/settings'))).json();
    const response = await putSettings(
      await createAuthedEditorRequest('http://localhost/api/data/settings', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          settings: createSettings('Next Site'),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'settings-write',
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('settings-write');
  });
});
