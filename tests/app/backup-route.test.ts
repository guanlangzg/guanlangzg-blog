import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/data/backup/route';
import { GET as GET_CURRENT_MANIFEST } from '@/app/api/data/backup/current-manifest/route';
import {
  getRemoteBackupQueueSnapshot,
  queueCurrentBackupToRemote,
  shouldQueueRemoteBackupRetry,
  syncCurrentBackupToRemote,
} from '@/lib/editor-remote-backup';
import { writeArticlesToDisk } from '@/lib/editor-data-storage';
import { storeEditorMediaFile } from '@/lib/editor-media-storage';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/editor-remote-backup', () => ({
  getRemoteBackupQueueSnapshot: vi.fn(),
  queueCurrentBackupToRemote: vi.fn(),
  shouldQueueRemoteBackupRetry: vi.fn(),
  syncCurrentBackupToRemote: vi.fn(),
}));

vi.mock('@/lib/public-cache-invalidation', () => ({
  invalidatePublicContentCache: vi.fn(),
}));

const mockedGetRemoteBackupQueueSnapshot = vi.mocked(getRemoteBackupQueueSnapshot);
const mockedQueueCurrentBackupToRemote = vi.mocked(queueCurrentBackupToRemote);
const mockedShouldQueueRemoteBackupRetry = vi.mocked(shouldQueueRemoteBackupRetry);
const mockedSyncCurrentBackupToRemote = vi.mocked(syncCurrentBackupToRemote);
const mockedInvalidatePublicContentCache = vi.mocked(invalidatePublicContentCache);

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const ORIGINAL_CWD = process.cwd();
const tempDirectories: string[] = [];
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function resetEnv(): void {
  restoreEnv(ORIGINAL_ENV);
}

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-backup-route-');
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

function seedRuntimeData(dataRoot: string): void {
  writeJson(path.join(dataRoot, 'articles', 'articles.json'), [
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
  writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
  writeJson(path.join(dataRoot, 'settings', 'site.json'), {
    siteName: 'Existing Site',
    siteDescription: 'Existing settings',
    workspaceLabel: 'workspace / existing',
    heroTitleLineOne: 'Existing',
    heroTitleLineTwo: 'Data',
    heroDescription: 'Existing runtime data.',
  });
}

async function readCurrentManifest(): Promise<unknown> {
  const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'));
  const payload = await response.json();

  expect(response.status).toBe(200);
  return payload.manifest;
}

async function readCurrentRestorePrecondition(): Promise<unknown> {
  const response = await GET_CURRENT_MANIFEST(
    await createAuthedEditorRequest('http://localhost/api/data/backup/current-manifest')
  );
  const payload = await response.json();

  expect(response.status).toBe(200);
  return {
    manifest: payload.manifest,
    mediaHash: payload.mediaHash,
  };
}

async function createAuthenticatedHeaders(): Promise<Headers> {
  const currentRoot = process.env.BLOG_DATA_ROOT;

  process.env.BLOG_DATA_ROOT = createTempDataRoot();

  try {
    const request = await createAuthedEditorRequest('http://localhost/api/data/backup');

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
  process.chdir(createTempDataRoot());
  vi.clearAllMocks();
  mockedGetRemoteBackupQueueSnapshot.mockResolvedValue({
    backupQueue: {
      pending: 0,
      failed: 0,
      failedTasks: [],
    },
    backupQueueMessage: null,
  });
  mockedQueueCurrentBackupToRemote.mockResolvedValue({
    queued: true,
    enabled: true,
    success: null,
    message: 'R2 backup sync has been queued.',
  });
  mockedShouldQueueRemoteBackupRetry.mockImplementation((remoteBackup) => (
    remoteBackup.enabled === true &&
    remoteBackup.success === false &&
    !('invalidConfiguration' in remoteBackup && remoteBackup.invalidConfiguration) &&
    !('runtimeDataUnavailable' in remoteBackup && remoteBackup.runtimeDataUnavailable)
  ));
  mockedSyncCurrentBackupToRemote.mockResolvedValue({
    enabled: false,
    success: false,
    message: 'R2 backup is disabled.',
  });
});

afterEach(() => {
  resetEnv();
  process.chdir(ORIGINAL_CWD);
  cleanupTempDirectories(tempDirectories);
});

describe('backup API', () => {
  it('rejects unauthenticated reads and writes', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const getResponse = await GET(new NextRequest('http://localhost/api/data/backup'));
    const postResponse = await POST(
      new NextRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({ data: { articles: [], navigation: [] } }),
      })
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
  });

  it('exports the current backup payload for authenticated reads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        version: 1,
        source: 'local',
        persistent: true,
        data: expect.objectContaining({
          articles: expect.arrayContaining([
            expect.objectContaining({
              id: 'article-1',
            }),
          ]),
          navigation: [],
          media: {
            manifest: expect.objectContaining({
              version: 1,
              assets: [
                expect.objectContaining({
                  path: storedMedia.asset.path,
                  hash: storedMedia.asset.hash,
                }),
              ],
            }),
            files: [
              {
                path: storedMedia.asset.path,
                data: Buffer.from(PNG_BYTES).toString('base64'),
              },
            ],
          },
        }),
      })
    );
  });

  it('rejects backup export when runtime data is corrupt', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    writeText(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), '{');

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        message: '服务器运行时数据文件损坏，请修复数据文件后重试。',
        resource: 'articles',
      })
    );
  });

  it('reports backup export lock contention as a retryable conflict', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    fs.mkdirSync(path.join(process.env.BLOG_DATA_ROOT, '.data-write.lock'));

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'));

    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({
      message: '服务器运行时数据正在写入，请稍后重试。',
    });
  }, 10000);

  it('reports backup export when the runtime data root path is unavailable', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
  });

  it('uses the default data directory before validating restore preconditions', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    delete process.env.BLOG_DATA_ROOT;

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({ data: { articles: [], navigation: [] } }),
      })
    );

    expect(response.status).toBe(409);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects invalid backup payloads without remote sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({ currentManifest, data: { articles: 'invalid', navigation: [] } }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份文件必须包含 articles 和 navigation 数组。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a specific restore error when backup articles contain duplicate slugs', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 1,
          data: {
            articles: [
              {
                id: 'article-1',
                title: 'Duplicate One',
                date: '2026-05-24',
                description: 'Duplicate slug one',
                tags: [],
                content: '# Duplicate One',
                slug: 'same',
                createdAt: 1,
                updatedAt: 2,
              },
              {
                id: 'article-2',
                title: 'Duplicate Two',
                date: '2026-05-24',
                description: 'Duplicate slug two',
                tags: [],
                content: '# Duplicate Two',
                slug: 'same',
                createdAt: 3,
                updatedAt: 4,
              },
            ],
            navigation: [],
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '文章 slug 重复：same',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when restoring a backup from a newer schemaVersion', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 1,
          schemaVersion: 999,
          data: {
            articles: [],
            navigation: [],
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份 schemaVersion 999 高于当前支持的 1，请先升级服务后再恢复。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when restoring a backup from a newer version', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 999,
          data: {
            articles: [],
            navigation: [],
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份 version 999 高于当前支持的 1，请先升级服务后再恢复。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when restoring an encrypted backup payload through the local restore API', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 1,
          algorithm: 'aes-256-gcm',
          keyDerivation: 'scrypt',
          iv: 'aaaaaaaaaaaaaaaa',
          authTag: 'bbbbbbbbbbbbbbbb',
          ciphertext: 'cccccccccccccccc',
          salt: 'dddddddddddddddd',
          magic: 'blog-navigation-encrypted-backup',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('restores valid backup payloads and writes a remote restore snapshot', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const backupPayload = await (await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'))).json();
    const currentManifest = backupPayload.manifest;

    fs.rmSync(path.join(process.env.BLOG_DATA_ROOT, 'media'), { recursive: true, force: true });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          ...backupPayload,
          currentManifest,
        }),
      })
    );
    const payload = await response.json();
    const restoredArticles = JSON.parse(
      fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8')
    );
    const restoredMediaManifest = JSON.parse(
      fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'media', 'manifest.json'), 'utf8')
    );
    const restoredMediaFile = fs.readFileSync(
      path.join(process.env.BLOG_DATA_ROOT, 'media', storedMedia.asset.path)
    );

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        counts: expect.objectContaining({
          articles: 1,
          categories: 0,
          settings: true,
          media: 1,
        }),
      })
    );
    expect(restoredArticles).toEqual([
      expect.objectContaining({
        id: 'article-1',
        slug: expect.any(String),
      }),
    ]);
    expect(restoredMediaManifest.assets).toEqual([
      expect.objectContaining({
        path: storedMedia.asset.path,
        hash: storedMedia.asset.hash,
      }),
    ]);
    expect(new Uint8Array(restoredMediaFile)).toEqual(PNG_BYTES);
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'local-restore',
      writeSnapshot: true,
    });
    expect(payload.backupQueue).toEqual({
      pending: 0,
      failed: 0,
      failedTasks: [],
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('local-restore');
  });

  it('requeues local restore snapshot sync when the post-restore R2 upload fails transiently', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const backupPayload = await (await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'))).json();
    const currentManifest = backupPayload.manifest;

    mockedSyncCurrentBackupToRemote.mockResolvedValueOnce({
      enabled: true,
      success: false,
      message: 'R2 upload failed.',
    });
    mockedGetRemoteBackupQueueSnapshot.mockResolvedValue({
      backupQueue: {
        pending: 1,
        failed: 0,
        failedTasks: [],
      },
      backupQueueMessage: null,
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          ...backupPayload,
          currentManifest,
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'local-restore',
      writeSnapshot: true,
    });
    expect(payload.remoteBackup).toEqual({
      enabled: true,
      success: false,
      message: 'R2 upload failed.',
    });
    expect(payload.backupQueue).toEqual({
      pending: 1,
      failed: 0,
      failedTasks: [],
    });
  });

  it('rejects local restores when media manifest exists without inline files', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const backupPayload = await (await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'))).json();
    const currentManifest = backupPayload.manifest;

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          data: {
            articles: backupPayload.data.articles,
            navigation: backupPayload.data.navigation,
            settings: backupPayload.data.settings,
            media: backupPayload.data.media.manifest,
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份媒体文件缺失或不完整。',
    });
    expect(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'media', storedMedia.asset.path))).toEqual(
      Buffer.from(PNG_BYTES)
    );
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('reports backup restore when the runtime data root path is unavailable', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const currentManifest = await readCurrentManifest();
    const headers = await createAuthenticatedHeaders();

    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const response = await POST(new NextRequest('http://localhost/api/data/backup', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        currentManifest,
        data: {
          articles: [],
          navigation: [],
        },
      }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects stale local restores without replacing newer data', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const currentManifest = await readCurrentManifest();
    const newerArticle = {
      id: 'article-newer',
      title: 'Newer Article',
      date: '2026-05-25',
      description: 'Newer article',
      tags: [],
      content: '# Newer',
      slug: 'newer-article',
      createdAt: 3,
      updatedAt: 4,
    };

    writeJson(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), [newerArticle]);

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 1,
          data: {
            articles: [
              {
                id: 'article-old',
                title: 'Old Backup Article',
                date: '2026-05-20',
                description: 'Old backup article',
                tags: [],
                content: '# Old',
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            navigation: [],
          },
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '当前数据已被其他会话更新，请刷新后重新执行恢复。',
        currentManifest: expect.any(Object),
      })
    );
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'article-newer',
      }),
    ]);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects stale local restores after another manifest-backed write', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const currentManifest = await readCurrentManifest();
    const newerArticle = {
      id: 'article-newer-manifest',
      title: 'Newer Manifest Article',
      date: '2026-05-25',
      description: 'Newer article with manifest update',
      tags: [],
      content: '# Newer Manifest',
      slug: 'newer-manifest-article',
      createdAt: 3,
      updatedAt: 4,
    };

    await writeArticlesToDisk([newerArticle]);

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          currentManifest,
          version: 1,
          data: {
            articles: [
              {
                id: 'article-old-manifest',
                title: 'Old Manifest Backup Article',
                date: '2026-05-20',
                description: 'Old backup article',
                tags: [],
                content: '# Old Manifest',
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            navigation: [],
          },
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'article-newer-manifest',
      }),
    ]);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects local restores when media changed after the restore precondition was captured', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const backupPayload = await (await GET(await createAuthedEditorRequest('http://localhost/api/data/backup'))).json();
    const currentManifest = await readCurrentRestorePrecondition();

    await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup', {
        method: 'POST',
        body: JSON.stringify({
          ...backupPayload,
          currentManifest,
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(
      expect.objectContaining({
        message: '当前数据已被其他会话更新，请刷新后重新执行恢复。',
        currentManifest: expect.objectContaining({
          manifest: expect.any(Object),
          mediaHash: expect.any(String),
        }),
      })
    );
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });
});
