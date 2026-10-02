import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/data/backup/current-manifest/route';
import {
  readEditorDataManifest,
  writeArticlesToDisk,
  writeNavigationToDisk,
  writeSiteSettingsToDisk,
} from '@/lib/editor-data-storage';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-current-manifest-route-');
  tempDirectories.push(directory);
  return directory;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('backup current manifest API', () => {
  it('returns the current manifest with a media hash without parsing media manifest JSON', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    await writeArticlesToDisk([
      {
        id: 'article-1',
        title: 'Existing Article',
        date: '2026-05-24',
        description: 'Existing article',
        tags: [],
        content: '# Existing',
        slug: 'existing-article',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    await writeNavigationToDisk([]);
    await writeSiteSettingsToDisk({
      ...DEFAULT_SITE_SETTINGS,
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing runtime data.',
    });
    writeText(path.join(dataRoot, 'media', 'manifest.json'), '{');

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          version: 1,
          resources: expect.objectContaining({
            articles: expect.objectContaining({
              hash: expect.any(String),
            }),
            navigation: expect.objectContaining({
              hash: expect.any(String),
            }),
            settings: expect.objectContaining({
              hash: expect.any(String),
            }),
          }),
        }),
        mediaHash: expect.any(String),
      })
    );
  });

  it('rebuilds changed resource manifests from runtime data when manifest.json is stale', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;

    await writeArticlesToDisk([
      {
        id: 'article-1',
        title: 'Original Article',
        date: '2026-05-24',
        description: 'Original article',
        tags: [],
        content: '# Original',
        slug: 'original-article',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    await writeNavigationToDisk([]);
    await writeSiteSettingsToDisk({
      ...DEFAULT_SITE_SETTINGS,
      siteName: 'Original Site',
      siteDescription: 'Original settings',
      workspaceLabel: 'workspace / original',
      heroTitleLineOne: 'Original',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Original runtime data.',
    });

    const staleManifest = readEditorDataManifest();

    writeJson(
      path.join(dataRoot, 'articles', 'articles.json'),
      [
        {
          id: 'article-2',
          title: 'Changed Article',
          date: '2026-05-25',
          description: 'Changed article',
          tags: [],
          content: '# Changed',
          slug: 'changed-article',
          createdAt: 3,
          updatedAt: 4,
        },
      ]
    );

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest'));
    const payload = await response.json();
    const manifest = payload.manifest;

    expect(response.status).toBe(200);
    expect(manifest).toEqual(
      expect.objectContaining({
        resources: expect.objectContaining({
          articles: expect.objectContaining({
            hash: expect.any(String),
            revision: expect.stringMatching(/^derived-/),
          }),
          navigation: staleManifest.resources.navigation,
          settings: staleManifest.resources.settings,
        }),
      })
    );
    expect(manifest.resources.articles.hash).not.toBe(staleManifest.resources.articles?.hash);
    expect(manifest.resources.articles.revision).not.toBe(staleManifest.resources.articles?.revision);
  });

  it('reports corrupt runtime data with a structured JSON error', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeText(path.join(dataRoot, 'articles', 'articles.json'), '{');

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '服务器运行时数据文件损坏，请修复数据文件后重试。',
        resource: 'articles',
      })
    );
  });

  it('reports current-manifest lock contention as a retryable conflict', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    fs.mkdirSync(path.join(dataRoot, '.data-write.lock'));

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest'));

    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({
      message: '服务器运行时数据正在写入，请稍后重试。',
    });
  }, 10000);

  it('reports current-manifest export when the runtime data root path is unavailable', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
  });
});
