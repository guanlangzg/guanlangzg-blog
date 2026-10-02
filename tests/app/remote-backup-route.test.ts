import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/data/backup/remote/route';
import { GET as GET_CURRENT_MANIFEST } from '@/app/api/data/backup/current-manifest/route';
import { POST as POST_RESTORE } from '@/app/api/data/backup/remote/restore/route';
import { POST as POST_RETRY } from '@/app/api/data/backup/remote/retry/route';
import { POST as POST_SYNC } from '@/app/api/data/backup/remote/sync/route';
import {
  downloadLatestBackupPayloadFromR2,
  getR2BackupStatus,
  R2BackupPayloadTooLargeError,
  R2BackupSettingsInvalidError,
} from '@/lib/r2-backup-storage';
import {
  materializeLatestChunkedBackupFromR2,
  R2ChunkedBackupNotFoundError,
} from '@/lib/r2-chunked-backup-storage';
import {
  EditorMediaRestoreDownloadError,
  materializeEditorMediaRestoreDataFromR2,
} from '@/lib/editor-media-remote';
import {
  getRemoteBackupQueueSnapshot,
  queueCurrentBackupToRemote,
  retryFailedRemoteBackups,
  shouldQueueRemoteBackupRetry,
  syncCurrentBackupToRemote,
} from '@/lib/editor-remote-backup';
import { writeArticlesToDisk } from '@/lib/editor-data-storage';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/r2-backup-storage', () => {
  class R2BackupNotConfiguredError extends Error {
    constructor(message = 'Cloudflare R2 backup is not configured.') {
      super(message);
      this.name = 'R2BackupNotConfiguredError';
    }
  }

  class R2BackupSettingsInvalidError extends Error {
    constructor(public readonly filePath = 'cloudflare-r2.json') {
      super('Stored Cloudflare R2 settings are invalid.');
      this.name = 'R2BackupSettingsInvalidError';
    }
  }

  class R2BackupPayloadTooLargeError extends Error {
    constructor(public readonly limitBytes = 5 * 1024 * 1024) {
      super(`R2 backup payload exceeds ${limitBytes} bytes.`);
      this.name = 'R2BackupPayloadTooLargeError';
    }
  }

  return {
    R2BackupNotConfiguredError,
    R2BackupPayloadTooLargeError,
    R2BackupSettingsInvalidError,
    downloadLatestBackupPayloadFromR2: vi.fn(),
    getR2BackupStatus: vi.fn(),
  };
});

vi.mock('@/lib/r2-chunked-backup-storage', () => {
  class R2ChunkedBackupNotFoundError extends Error {
    constructor(message = 'R2 chunked backup was not found.') {
      super(message);
      this.name = 'R2ChunkedBackupNotFoundError';
    }
  }

  return {
    R2ChunkedBackupNotFoundError,
    R2ChunkedBackupFormatError: class R2ChunkedBackupFormatError extends Error {},
    R2ChunkedBackupIntegrityError: class R2ChunkedBackupIntegrityError extends Error {},
    R2ChunkedBackupObjectMissingError: class R2ChunkedBackupObjectMissingError extends Error {},
    materializeLatestChunkedBackupFromR2: vi.fn(),
  };
});

vi.mock('@/lib/editor-media-remote', () => {
  class EditorMediaRestoreDownloadError extends Error {
    constructor(public readonly result: {
      total: number;
      restored: number;
      skipped: number;
      failed: number;
      failures: Array<{ path: string; message: string }>;
    }) {
      super(`Failed to prepare ${result.failed} media file(s) from R2.`);
      this.name = 'EditorMediaRestoreDownloadError';
    }
  }

  return {
    EditorMediaRestoreDownloadError,
    materializeEditorMediaRestoreDataFromR2: vi.fn(),
  };
});

vi.mock('@/lib/editor-remote-backup', () => ({
  getRemoteBackupQueueSnapshot: vi.fn(),
  queueCurrentBackupToRemote: vi.fn(),
  retryFailedRemoteBackups: vi.fn(),
  shouldQueueRemoteBackupRetry: vi.fn(),
  syncCurrentBackupToRemote: vi.fn(),
}));

vi.mock('@/lib/public-cache-invalidation', () => ({
  invalidatePublicContentCache: vi.fn(),
}));

const mockedGetR2BackupStatus = vi.mocked(getR2BackupStatus);
const mockedDownloadLatestBackupPayloadFromR2 = vi.mocked(downloadLatestBackupPayloadFromR2);
const mockedMaterializeLatestChunkedBackupFromR2 = vi.mocked(materializeLatestChunkedBackupFromR2);
const mockedMaterializeEditorMediaRestoreDataFromR2 = vi.mocked(materializeEditorMediaRestoreDataFromR2);
const mockedGetRemoteBackupQueueSnapshot = vi.mocked(getRemoteBackupQueueSnapshot);
const mockedQueueCurrentBackupToRemote = vi.mocked(queueCurrentBackupToRemote);
const mockedRetryFailedRemoteBackups = vi.mocked(retryFailedRemoteBackups);
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
  const directory = createTempDirectory('blog-navigation-remote-backup-route-');
  tempDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function readCurrentManifest(): Promise<unknown> {
  const { GET: getBackup } = await import('@/app/api/data/backup/route');
  const response = await getBackup(await createAuthedEditorRequest('http://localhost/api/data/backup'));
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
  mockedMaterializeLatestChunkedBackupFromR2.mockRejectedValue(new R2ChunkedBackupNotFoundError());
  mockedQueueCurrentBackupToRemote.mockResolvedValue({
    queued: true,
    enabled: true,
    success: null,
    message: 'R2 backup sync has been queued.',
  });
  mockedMaterializeEditorMediaRestoreDataFromR2.mockResolvedValue({
    media: undefined,
    result: {
      total: 0,
      restored: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    },
  });
  mockedRetryFailedRemoteBackups.mockResolvedValue({
    retried: 0,
    backupQueue: {
      pending: 0,
      failed: 0,
      failedTasks: [],
    },
  });
  mockedShouldQueueRemoteBackupRetry.mockImplementation((remoteBackup) => (
    remoteBackup.enabled === true &&
    remoteBackup.success === false &&
    !('invalidConfiguration' in remoteBackup && remoteBackup.invalidConfiguration) &&
    !('runtimeDataUnavailable' in remoteBackup && remoteBackup.runtimeDataUnavailable)
  ));
  mockedGetR2BackupStatus.mockReturnValue({
    enabled: false,
    configured: false,
    bucket: null,
    prefix: 'blog-navigation',
    endpoint: null,
    snapshotOnWrite: false,
    hasAccessKeyId: false,
    hasSecretAccessKey: false,
    source: 'default',
    message: null,
    securityWarning: null,
  });
});

afterEach(() => {
  resetEnv();
  process.chdir(ORIGINAL_CWD);
  cleanupTempDirectories(tempDirectories);
});

describe('remote backup API', () => {
  it('rejects unauthenticated reads and writes', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const getResponse = await GET(new NextRequest('http://localhost/api/data/backup/remote'));
    const postResponse = await POST(
      new NextRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      })
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
  });

  it('returns the R2 status for authenticated reads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/remote'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        enabled: false,
        configured: false,
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );
  });

  it('returns failed queue status for authenticated reads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    mockedGetRemoteBackupQueueSnapshot.mockResolvedValue({
      backupQueue: {
        pending: 0,
        failed: 1,
        failedTasks: [
          {
            id: 'failed-task',
            reason: 'articles-write',
            attempts: 3,
            lastAttemptAt: '2026-06-07T00:00:00.000Z',
            lastError: 'R2 temporarily unavailable.',
          },
        ],
      },
      backupQueueMessage: null,
    });

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/remote'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        backupQueue: expect.objectContaining({
          failed: 1,
          failedTasks: [
            expect.objectContaining({
              reason: 'articles-write',
              lastError: 'R2 temporarily unavailable.',
            }),
          ],
        }),
      })
    );
  });

  it('still returns R2 status when the backup queue state cannot be read', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    mockedGetRemoteBackupQueueSnapshot.mockResolvedValue({
      backupQueue: null,
      backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
    });

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/remote'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        enabled: false,
        configured: false,
        backupQueue: null,
        backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
      })
    );
  });

  it('reports corrupt R2 settings for authenticated reads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    mockedGetR2BackupStatus.mockImplementation(() => {
      throw new R2BackupSettingsInvalidError('cloudflare-r2.json');
    });

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/backup/remote'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
      })
    );
  });

  it('uses the default data directory before running remote backup actions', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    delete process.env.BLOG_DATA_ROOT;
    mockedSyncCurrentBackupToRemote.mockResolvedValueOnce({
      enabled: false,
      success: false,
      message: 'R2 backup is disabled.',
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: false,
        remoteBackup: expect.objectContaining({
          enabled: false,
        }),
      })
    );
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'manual-sync',
      writeSnapshot: true,
    });
  });

  it('rejects unknown actions without running a sync fallback', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete-all' }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: '远端备份操作无效。',
      })
    );
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
    expect(mockedDownloadLatestBackupPayloadFromR2).not.toHaveBeenCalled();
  });

  it('rejects malformed action JSON without running remote operations', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: '{',
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: 'invalid_json',
      })
    );
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
    expect(mockedDownloadLatestBackupPayloadFromR2).not.toHaveBeenCalled();
  });

  it('reports disabled R2 sync without treating it as success', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: false,
      success: false,
      message: 'R2 backup is disabled.',
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(
      expect.objectContaining({
        success: false,
        remoteBackup: expect.objectContaining({
          enabled: false,
        }),
      })
    );
  });

  it('requeues failed remote backup tasks through the retry endpoint', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedRetryFailedRemoteBackups.mockResolvedValue({
      retried: 1,
      backupQueue: {
        pending: 1,
        failed: 0,
        failedTasks: [],
      },
    });

    const response = await POST_RETRY(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/retry', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      retried: 1,
      backupQueue: {
        pending: 1,
        failed: 0,
        failedTasks: [],
      },
      backupQueueMessage: null,
    });
    expect(mockedRetryFailedRemoteBackups).toHaveBeenCalledTimes(1);
  });

  it('returns a structured queue error when retrying failed tasks cannot read queue state', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedRetryFailedRemoteBackups.mockImplementation(() => {
      throw new Error('Pending backup queue state is invalid.');
    });
    mockedGetRemoteBackupQueueSnapshot.mockResolvedValue({
      backupQueue: null,
      backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
    });

    const response = await POST_RETRY(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/retry', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: '云端备份队列状态文件损坏，请检查并修复。',
      backupQueue: null,
      backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
    });
    expect(mockedRetryFailedRemoteBackups).toHaveBeenCalledTimes(1);
  });

  it('syncs through the resource remote sync endpoint', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: true,
      latestKey: 'blog-navigation/latest/backup.json',
      snapshotKey: 'blog-navigation/snapshots/backup.json',
    });

    const response = await POST_SYNC(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/sync', {
        method: 'POST',
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        remoteBackup: expect.objectContaining({
          success: true,
        }),
      })
    );
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'manual-sync',
      writeSnapshot: true,
    });
  });

  it('reports corrupt R2 settings during manual sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: false,
      invalidConfiguration: true,
      message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual(
      expect.objectContaining({
        success: false,
        remoteBackup: expect.objectContaining({
          invalidConfiguration: true,
        }),
      })
    );
  });

  it('reports runtime data root failures during manual sync as a structured 503 state', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: false,
      runtimeDataUnavailable: true,
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'sync' }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual(
      expect.objectContaining({
        success: false,
        remoteBackup: expect.objectContaining({
          runtimeDataUnavailable: true,
          message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
        }),
      })
    );
  });

  it('reports oversized remote backup downloads without treating the request body as too large', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockRejectedValue(
      new R2BackupPayloadTooLargeError(128 * 1024 * 1024)
    );

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload).toEqual(
      expect.objectContaining({
        code: 'remote_backup_too_large',
        message: expect.stringContaining('R2 远端备份文件超过'),
      })
    );
    expect(payload.code).not.toBe('body_too_large');
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('reports invalid latest R2 backup JSON with a clear restore error message', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockRejectedValue(
      new Error('Latest R2 backup is not valid JSON.')
    );

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: 'R2 最新备份不是合法 JSON，恢复失败。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('reports missing latest R2 backups with a clear restore error message', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockRejectedValue(
      new Error('Latest R2 backup was not found at blog-navigation/latest/backup.json.')
    );

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: 'R2 最新备份不存在，恢复失败。',
    });
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects invalid R2 restore payloads without replacing local data', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-article-1',
      title: 'Existing Article',
      date: '2026-05-24',
      description: 'Existing data must survive invalid R2 restores',
      tags: [],
      content: '# Existing',
      slug: 'existing-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Invalid restore should not replace this.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: 'invalid-articles',
        navigation: [],
      },
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'restore', currentManifest }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份文件必须包含 articles 和 navigation 数组。',
    });
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when the latest R2 backup uses a newer schemaVersion', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-schema-article-1',
      title: 'Existing Schema Article',
      date: '2026-05-24',
      description: 'Existing data must survive newer remote schemas',
      tags: [],
      content: '# Existing Schema',
      slug: 'existing-schema-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Newer remote schema should not replace this.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      schemaVersion: 999,
      data: {
        articles: [],
        navigation: [],
      },
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份 schemaVersion 999 高于当前支持的 1，请先升级服务后再恢复。',
    });
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a specific restore error when the latest R2 backup contains an unsafe navigation URL', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-navigation-article-1',
      title: 'Existing Navigation Article',
      date: '2026-05-24',
      description: 'Existing data must survive invalid navigation payloads',
      tags: [],
      content: '# Existing Navigation',
      slug: 'existing-navigation-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Invalid remote navigation should not replace this.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [],
        navigation: [
          {
            name: '开发文档',
            icon: 'blog',
            slug: 'developer-docs',
            tools: [
              {
                icon: 'blog',
                title: 'MDN Web Docs',
                description: 'Web 平台权威文档',
                url: 'http://developer.mozilla.org',
                tags: ['文档'],
              },
            ],
          },
        ],
      },
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '导航工具必须包含 icon、title、description 和 HTTPS URL。',
    });
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when the latest R2 backup uses a newer version', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-version-article-1',
      title: 'Existing Version Article',
      date: '2026-05-24',
      description: 'Existing data must survive newer remote versions',
      tags: [],
      content: '# Existing Version',
      slug: 'existing-version-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Newer remote version should not replace this.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 999,
      data: {
        articles: [],
        navigation: [],
      },
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '备份 version 999 高于当前支持的 1，请先升级服务后再恢复。',
    });
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('returns a clear error when the latest R2 backup is an encrypted backup payload', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-encrypted-article-1',
      title: 'Existing Encrypted Article',
      date: '2026-05-24',
      description: 'Existing data must survive encrypted remote payloads',
      tags: [],
      content: '# Existing Encrypted',
      slug: 'existing-encrypted-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Encrypted remote payload should not replace this.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      magic: 'blog-navigation-encrypted-backup',
      version: 1,
      algorithm: 'aes-256-gcm',
      keyDerivation: 'scrypt',
      iv: 'aaaaaaaaaaaaaaaa',
      authTag: 'bbbbbbbbbbbbbbbb',
      ciphertext: 'cccccccccccccccc',
      salt: 'dddddddddddddddd',
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: '检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。',
    });
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('restores through the resource remote restore endpoint', async () => {
    const dataRoot = createTempDataRoot();
    const remoteArticle = {
      id: 'remote-article-1',
      title: 'Remote Article',
      date: '2026-05-24',
      description: 'Remote data',
      tags: [],
      content: '# Remote',
      slug: 'remote-article',
      createdAt: 1,
      updatedAt: 2,
    };
    const mediaAsset = {
      id: '843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9',
      path: 'files/2026/06/843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9.png',
      publicPath: '/media/files/2026/06/843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9.png',
      mimeType: 'image/png' as const,
      size: PNG_BYTES.byteLength,
      hash: '843ac23b1736b4487ec81cf7c07ddd9bb46ae5b7818c2c3843d99d62fa75f3c9',
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    };
    const mediaManifest = {
      version: 1 as const,
      updatedAt: '2026-06-19T00:00:00.000Z',
      assets: [mediaAsset],
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [remoteArticle],
        navigation: [],
        media: mediaManifest,
      },
    });
    mockedMaterializeEditorMediaRestoreDataFromR2.mockResolvedValue({
      media: {
        manifest: mediaManifest,
        files: [
          {
            path: mediaAsset.path,
            bytes: PNG_BYTES,
          },
        ],
      },
      result: {
        total: 1,
        restored: 1,
        skipped: 0,
        failed: 0,
        failures: [],
      },
    });
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: true,
      latestKey: 'blog-navigation/latest/backup.json',
      snapshotKey: 'blog-navigation/snapshots/backup.json',
    });

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        counts: expect.objectContaining({
          articles: 1,
        }),
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'remote-article-1',
      }),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        version: 1,
        assets: [mediaAsset],
        updatedAt: expect.any(String),
      })
    );
    expect(fs.readFileSync(path.join(dataRoot, 'media', mediaAsset.path))).toEqual(Buffer.from(PNG_BYTES));
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenNthCalledWith(1, {
      reason: 'pre-remote-restore',
      writeSnapshot: true,
      writeLatest: false,
    });
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenNthCalledWith(2, {
      reason: 'remote-restore',
      writeSnapshot: true,
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('remote-restore');
    expect(mockedMaterializeEditorMediaRestoreDataFromR2).toHaveBeenCalledWith(mediaManifest);
  });

  it('prefers the v2 chunked R2 backup when it exists', async () => {
    const dataRoot = createTempDataRoot();
    const remoteArticle = {
      id: 'remote-v2-article-1',
      title: 'Remote V2 Article',
      date: '2026-05-24',
      description: 'Remote v2 data',
      tags: [],
      content: '# Remote V2',
      slug: 'remote-v2-article',
      createdAt: 1,
      updatedAt: 2,
      kind: 'essay' as const,
      status: 'published' as const,
      featured: false,
      sourceLinks: [],
      revisionNotes: [],
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();

    mockedMaterializeLatestChunkedBackupFromR2.mockResolvedValue({
      format: 'v2-chunked',
      snapshotId: 'snapshot-v2',
      data: {
        articles: [remoteArticle],
        navigation: [],
        settings: {
          siteName: 'Remote V2 Site',
          siteDescription: 'Remote v2 settings',
          workspaceLabel: 'workspace / remote-v2',
          heroTitleLineOne: 'Remote',
          heroTitleLineTwo: 'V2',
          heroDescription: 'Restored from v2.',
          showIntroCard: true,
          introCardEyebrow: 'about',
          introCardTitle: 'Remote',
          introCardDescription: 'Remote intro',
          introCardMetaOneLabel: 'one',
          introCardMetaOneValue: '1',
          introCardMetaTwoLabel: 'two',
          introCardMetaTwoValue: '2',
          introCardMetaThreeLabel: 'three',
          introCardMetaThreeValue: '3',
          introCardStartLabel: 'start',
        },
      },
      mediaRestore: {
        total: 0,
        restored: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      },
    });
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: true,
      format: 'v2-chunked',
      latestKey: 'blog-navigation/v2/latest.json',
      snapshotKey: 'blog-navigation/v2/snapshots/snapshot-v2/manifest.json',
      counts: {
        articles: 1,
        categories: 0,
        media: 0,
      },
    });

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        format: 'v2-chunked',
        counts: expect.objectContaining({
          articles: 1,
        }),
      })
    );
    expect(mockedDownloadLatestBackupPayloadFromR2).not.toHaveBeenCalled();
    expect(mockedMaterializeEditorMediaRestoreDataFromR2).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'remote-v2-article-1',
      }),
    ]);
  });

  it('queues a retryable remote snapshot sync when the follow-up remote restore backup fails', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [],
        navigation: [],
      },
    });
    mockedSyncCurrentBackupToRemote
      .mockResolvedValueOnce({
        enabled: true,
        success: true,
        latestKey: null,
        snapshotKey: 'blog-navigation/snapshots/pre-restore.json',
      })
      .mockResolvedValueOnce({
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

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        remoteBackup: expect.objectContaining({
          success: false,
          message: 'R2 upload failed.',
        }),
        backupQueue: {
          pending: 1,
          failed: 0,
          failedTasks: [],
        },
      })
    );
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'remote-restore',
      writeSnapshot: true,
    });
    expect(mockedInvalidatePublicContentCache).toHaveBeenCalledWith('remote-restore');
  });

  it('does not restore remote data when the pre-restore snapshot fails', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-article-1',
      title: 'Existing Article',
      date: '2026-05-24',
      description: 'Existing data',
      tags: [],
      content: '# Existing',
      slug: 'existing-article',
      createdAt: 1,
      updatedAt: 2,
    };
    const remoteArticle = {
      id: 'remote-article-1',
      title: 'Remote Article',
      date: '2026-05-24',
      description: 'Remote data',
      tags: [],
      content: '# Remote',
      slug: 'remote-article',
      createdAt: 1,
      updatedAt: 2,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [remoteArticle],
        navigation: [],
      },
    });
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: false,
      message: 'R2 backup sync failed.',
    });

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        remoteBackup: expect.objectContaining({
          success: false,
        }),
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'existing-article-1',
      }),
    ]);
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenCalledTimes(1);
  });

  it('cancels remote restore when R2 media objects cannot be materialized completely', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-article-1',
      title: 'Existing Article',
      date: '2026-05-24',
      description: 'Existing data',
      tags: [],
      content: '# Existing',
      slug: 'existing-article',
      createdAt: 1,
      updatedAt: 2,
    };
    const mediaManifest = {
      version: 1 as const,
      updatedAt: '2026-06-19T00:00:00.000Z',
      assets: [
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          path: 'files/2026/06/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
          publicPath: '/media/files/2026/06/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
          mimeType: 'image/png' as const,
          size: PNG_BYTES.byteLength,
          hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z',
        },
      ],
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [],
        navigation: [],
        media: mediaManifest,
      },
    });
    mockedMaterializeEditorMediaRestoreDataFromR2.mockRejectedValue(
      new EditorMediaRestoreDownloadError({
        total: 1,
        restored: 0,
        skipped: 0,
        failed: 1,
        failures: [
          {
            path: 'files/2026/06/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
            message: 'NoSuchKey: object not found.',
          },
        ],
      })
    );

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual(
      expect.objectContaining({
        message: 'R2 媒体文件不完整或校验失败，已取消恢复。',
        mediaRestore: {
          total: 1,
          restored: 0,
          skipped: 0,
          failed: 1,
          failures: [
            {
              path: 'files/2026/06/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
              message: 'NoSuchKey: object not found.',
            },
          ],
        },
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(fs.existsSync(path.join(dataRoot, 'media'))).toBe(false);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('reports runtime data root failures before remote restore replaces local data', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [],
        navigation: [],
      },
    });
    mockedSyncCurrentBackupToRemote.mockResolvedValue({
      enabled: true,
      success: false,
      runtimeDataUnavailable: true,
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual(
      expect.objectContaining({
        message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
        remoteBackup: expect.objectContaining({
          runtimeDataUnavailable: true,
        }),
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );
    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(mockedSyncCurrentBackupToRemote).toHaveBeenCalledTimes(1);
  });

  it('reports corrupt R2 settings before restoring remote data', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    mockedDownloadLatestBackupPayloadFromR2.mockRejectedValue(
      new R2BackupSettingsInvalidError('cloudflare-r2.json')
    );

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'restore', currentManifest }),
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
      })
    );
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects stale R2 restores without replacing newer local data', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-article-1',
      title: 'Existing Article',
      date: '2026-05-24',
      description: 'Existing data',
      tags: [],
      content: '# Existing',
      slug: 'existing-article',
      createdAt: 1,
      updatedAt: 2,
    };
    const newerArticle = {
      ...existingArticle,
      id: 'newer-article-1',
      title: 'Newer Article',
      slug: 'newer-article',
      updatedAt: 3,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [newerArticle]);
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [existingArticle],
        navigation: [],
      },
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'restore', currentManifest }),
      })
    );

    expect(response.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'newer-article-1',
      }),
    ]);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects stale R2 restores after another manifest-backed write', async () => {
    const dataRoot = createTempDataRoot();
    const existingArticle = {
      id: 'existing-article-1',
      title: 'Existing Article',
      date: '2026-05-24',
      description: 'Existing data',
      tags: [],
      content: '# Existing',
      slug: 'existing-article',
      createdAt: 1,
      updatedAt: 2,
    };
    const newerArticle = {
      ...existingArticle,
      id: 'newer-manifest-article-1',
      title: 'Newer Manifest Article',
      slug: 'newer-manifest-article',
      updatedAt: 3,
    };

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), [existingArticle]);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentManifest();
    await writeArticlesToDisk([newerArticle]);
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [existingArticle],
        navigation: [],
      },
    });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote', {
        method: 'POST',
        body: JSON.stringify({ action: 'restore', currentManifest }),
      })
    );

    expect(response.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'newer-manifest-article-1',
      }),
    ]);
    expect(mockedSyncCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('rejects stale R2 restores when local media changed after the restore precondition was captured', async () => {
    const dataRoot = createTempDataRoot();

    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(path.join(dataRoot, 'articles', 'articles.json'), []);
    writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
    writeJson(path.join(dataRoot, 'settings', 'site.json'), {
      siteName: 'Existing Site',
      siteDescription: 'Existing settings',
      workspaceLabel: 'workspace / existing',
      heroTitleLineOne: 'Existing',
      heroTitleLineTwo: 'Data',
      heroDescription: 'Existing data.',
    });
    const currentManifest = await readCurrentRestorePrecondition();
    writeJson(path.join(dataRoot, 'media', 'manifest.json'), {
      version: 1,
      updatedAt: '2026-06-19T00:00:00.000Z',
      assets: [
        {
          id: 'a'.repeat(64),
          path: `files/2026/06/${'a'.repeat(64)}.png`,
          publicPath: `/media/files/2026/06/${'a'.repeat(64)}.png`,
          mimeType: 'image/png',
          size: 9,
          hash: 'a'.repeat(64),
          createdAt: '2026-06-19T00:00:00.000Z',
          updatedAt: '2026-06-19T00:00:00.000Z',
        },
      ],
    });
    mockedDownloadLatestBackupPayloadFromR2.mockResolvedValue({
      version: 1,
      data: {
        articles: [],
        navigation: [],
        media: {
          version: 1,
          updatedAt: '2026-06-18T00:00:00.000Z',
          assets: [],
        },
      },
    });

    const response = await POST_RESTORE(
      await createAuthedEditorRequest('http://localhost/api/data/backup/remote/restore', {
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
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
