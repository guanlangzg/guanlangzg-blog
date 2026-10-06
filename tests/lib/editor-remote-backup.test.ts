import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCurrentEditorManifestSnapshotReference,
  createCurrentEditorRemoteBackupPackage,
  createEditorDataManifestHash,
  isSameEditorManifestSnapshot,
} from '@/lib/editor-data-backup';
import {
  drainPendingBackups,
  getRemoteBackupQueueStatus,
  queueCurrentBackupToRemote,
  resetRemoteBackupQueueForTests,
  retryFailedRemoteBackups,
  syncCurrentBackupToRemote,
  waitForRemoteBackupQueueIdleForTests,
} from '@/lib/editor-remote-backup';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import {
  getR2BackupConfig,
  getR2BackupStatus,
  R2BackupSettingsInvalidError,
} from '@/lib/r2-backup-storage';
import {
  uploadChunkedBackupToR2,
  type R2ChunkedUploadResult,
} from '@/lib/r2-chunked-backup-storage';

vi.mock('@/lib/editor-data-backup', () => {
  const createEditorDataManifestHash = vi.fn((manifest: unknown) =>
    Buffer.from(JSON.stringify(manifest)).toString('hex').slice(0, 64).padEnd(64, '0')
  );

  return {
    createCurrentEditorManifestSnapshotReference: vi.fn(() => {
      const manifest = {
        version: 1,
        updatedAt: '2026-05-26T00:00:00.000Z',
        resources: {},
      };

      return {
        manifest,
        manifestHash: createEditorDataManifestHash(manifest),
      };
    }),
    createCurrentEditorRemoteBackupPackage: vi.fn(),
    createEditorDataManifestHash,
    isSameEditorManifestSnapshot: vi.fn((expected: unknown, current: unknown) =>
      JSON.stringify(expected) === JSON.stringify(current)
    ),
  };
});

vi.mock('@/lib/r2-backup-storage', () => {
  class R2BackupSettingsInvalidError extends Error {
    constructor(public readonly filePath = 'cloudflare-r2.json') {
      super('Stored Cloudflare R2 settings are invalid.');
      this.name = 'R2BackupSettingsInvalidError';
    }
  }

  return {
    getR2BackupConfig: vi.fn(),
    getR2BackupStatus: vi.fn(),
    R2BackupSettingsInvalidError,
  };
});

vi.mock('@/lib/r2-chunked-backup-storage', () => ({
  uploadChunkedBackupToR2: vi.fn(),
}));

const mockedCreateCurrentEditorManifestSnapshotReference = vi.mocked(createCurrentEditorManifestSnapshotReference);
const mockedCreateCurrentEditorRemoteBackupPackage = vi.mocked(createCurrentEditorRemoteBackupPackage);
const mockedCreateEditorDataManifestHash = vi.mocked(createEditorDataManifestHash);
const mockedIsSameEditorManifestSnapshot = vi.mocked(isSameEditorManifestSnapshot);
const mockedGetR2BackupConfig = vi.mocked(getR2BackupConfig);
const mockedGetR2BackupStatus = vi.mocked(getR2BackupStatus);
const mockedUploadChunkedBackupToR2 = vi.mocked(uploadChunkedBackupToR2);
const ORIGINAL_BLOG_DATA_ROOT = process.env.BLOG_DATA_ROOT;
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-remote-backup-'));

  tempDirectories.push(directory);
  process.env.BLOG_DATA_ROOT = directory;
  return directory;
}

function getPendingBackupFilePath(dataRoot: string): string {
  return path.join(dataRoot, '.backup-pending.json');
}

function createConfiguredStatus() {
  return {
    enabled: true,
    configured: true,
    bucket: 'blog-data',
    prefix: 'blog-navigation',
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    snapshotOnWrite: false,
    hasAccessKeyId: true,
    hasSecretAccessKey: true,
    source: 'env' as const,
    message: null,
    securityWarning: null,
  };
}

function createBackupPayload(id: string) {
  return {
    version: 1 as const,
    exportedAt: '2026-05-26T00:00:00.000Z',
    source: 'local' as const,
    persistent: true,
    dataRoot: '/var/lib/blog-navigation',
    data: {
      articles: [],
      navigation: [],
      settings: {
        ...DEFAULT_SITE_SETTINGS,
        siteName: id,
      },
    },
    manifest: {
      version: 1 as const,
      updatedAt: '2026-05-26T00:00:00.000Z',
      resources: {},
    },
  };
}

function createRemoteBackupPackage(id: string) {
  return {
    payload: createBackupPayload(id),
    mediaAssets: [],
  };
}

function createDeferred<T = R2ChunkedUploadResult>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve,
  };
}

// A drain lock held by a live process blocks the fire-and-forget drain until its
// five second wait times out, which is the failure path under test.
function holdDrainLock(dataRoot: string): string {
  const drainLockPath = path.join(dataRoot, '.backup-pending-drain.lock');

  fs.mkdirSync(drainLockPath, { recursive: true });
  fs.writeFileSync(path.join(drainLockPath, 'owner.json'), JSON.stringify({
    token: 'held-by-test',
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  return drainLockPath;
}

function releaseDrainLock(drainLockPath: string): void {
  fs.rmSync(drainLockPath, { recursive: true, force: true });
}

function collectUnhandledRejections() {
  const reasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason);
  };

  process.on('unhandledRejection', onUnhandledRejection);

  return {
    reasons,
    stop: () => process.off('unhandledRejection', onUnhandledRejection),
  };
}

function createChunkedUploadResult(snapshotId = 'snapshot-1'): R2ChunkedUploadResult {
  return {
    format: 'v2-chunked',
    latestKey: 'blog-navigation/v2/latest.json',
    snapshotKey: `blog-navigation/v2/snapshots/${snapshotId}/manifest.json`,
    snapshotId,
    counts: {
      articles: 0,
      categories: 0,
      media: 0,
    },
  };
}

describe('remote backup sync', () => {
  beforeEach(() => {
    createTempDataRoot();
    vi.clearAllMocks();
    resetRemoteBackupQueueForTests();
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('default'));
    mockedUploadChunkedBackupToR2.mockResolvedValue(createChunkedUploadResult());
  });

  afterEach(() => {
    resetRemoteBackupQueueForTests();

    if (ORIGINAL_BLOG_DATA_ROOT === undefined) {
      delete process.env.BLOG_DATA_ROOT;
    } else {
      process.env.BLOG_DATA_ROOT = ORIGINAL_BLOG_DATA_ROOT;
    }

    while (tempDirectories.length > 0) {
      fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
    }
  });

  it('reports invalid R2 settings without creating or uploading a backup payload', async () => {
    mockedGetR2BackupConfig.mockImplementation(() => {
      throw new R2BackupSettingsInvalidError('cloudflare-r2.json');
    });

    await expect(syncCurrentBackupToRemote({ reason: 'articles-write' })).resolves.toEqual({
      enabled: true,
      success: false,
      invalidConfiguration: true,
      message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
    });
    expect(mockedGetR2BackupStatus).not.toHaveBeenCalled();
    expect(mockedCreateCurrentEditorRemoteBackupPackage).not.toHaveBeenCalled();
    expect(mockedUploadChunkedBackupToR2).not.toHaveBeenCalled();
  });

  it('returns a structured failure when the persisted backup queue state is corrupt', async () => {
    const dataRoot = process.env.BLOG_DATA_ROOT as string;

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    fs.writeFileSync(getPendingBackupFilePath(dataRoot), '{', 'utf8');

    expect(await queueCurrentBackupToRemote({ reason: 'articles-write' })).toEqual({
      queued: false,
      enabled: true,
      success: false,
      queueStateInvalid: true,
      message: '云端备份队列状态文件损坏，请检查并修复。',
    });
    expect(mockedCreateCurrentEditorManifestSnapshotReference).not.toHaveBeenCalled();
    expect(mockedCreateCurrentEditorRemoteBackupPackage).not.toHaveBeenCalled();
    expect(mockedUploadChunkedBackupToR2).not.toHaveBeenCalled();
  });

  it('uploads referenced media objects as part of the chunked v2 backup', async () => {
    const mediaPackage = {
      payload: createBackupPayload('with-media'),
      mediaAssets: [
        {
          asset: {
            id: 'a'.repeat(64),
            path: `files/2026/06/${'a'.repeat(64)}.png`,
            publicPath: `/media/files/2026/06/${'a'.repeat(64)}.png`,
            mimeType: 'image/png' as const,
            size: 9,
            hash: 'a'.repeat(64),
            createdAt: '2026-06-19T00:00:00.000Z',
            updatedAt: '2026-06-19T00:00:00.000Z',
          },
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        },
      ],
    };

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(mediaPackage);

    await expect(syncCurrentBackupToRemote({ reason: 'articles-write' })).resolves.toEqual({
      enabled: true,
      success: true,
      format: 'v2-chunked',
      latestKey: 'blog-navigation/v2/latest.json',
      snapshotKey: 'blog-navigation/v2/snapshots/snapshot-1/manifest.json',
      counts: {
        articles: 0,
        categories: 0,
        media: 0,
      },
    });
    expect(mockedUploadChunkedBackupToR2).toHaveBeenCalledWith(mediaPackage, {
      reason: 'articles-write',
      writeSnapshot: false,
      writeLatest: undefined,
    });
  });

  it('reports a successful v2 backup without attempting any legacy v1 uploads', async () => {
    const mediaPackage = {
      payload: createBackupPayload('media-upload-failure'),
      mediaAssets: [
        {
          asset: {
            id: 'b'.repeat(64),
            path: `files/2026/06/${'b'.repeat(64)}.png`,
            publicPath: `/media/files/2026/06/${'b'.repeat(64)}.png`,
            mimeType: 'image/png' as const,
            size: 9,
            hash: 'b'.repeat(64),
            createdAt: '2026-06-19T00:00:00.000Z',
            updatedAt: '2026-06-19T00:00:00.000Z',
          },
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
        },
      ],
    };

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(mediaPackage);

    await expect(syncCurrentBackupToRemote({ reason: 'articles-write' })).resolves.toEqual({
      enabled: true,
      success: true,
      format: 'v2-chunked',
      latestKey: 'blog-navigation/v2/latest.json',
      snapshotKey: 'blog-navigation/v2/snapshots/snapshot-1/manifest.json',
      counts: {
        articles: 0,
        categories: 0,
        media: 0,
      },
    });
  });

  it('serializes queued write backups in durable order', async () => {
    const firstUpload = createDeferred<R2ChunkedUploadResult>();
    const chunkedResult = createChunkedUploadResult('latest');

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage
      .mockResolvedValueOnce(createRemoteBackupPackage('first'))
      .mockResolvedValueOnce(createRemoteBackupPackage('stale-middle'))
      .mockResolvedValueOnce(createRemoteBackupPackage('latest'));
    mockedUploadChunkedBackupToR2
      .mockReturnValueOnce(firstUpload.promise)
      .mockResolvedValue(chunkedResult);

    expect(await queueCurrentBackupToRemote({ reason: 'first-write' })).toEqual(
      expect.objectContaining({
        queued: true,
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    await queueCurrentBackupToRemote({ reason: 'stale-middle-write' });
    await queueCurrentBackupToRemote({ reason: 'latest-write' });

    firstUpload.resolve(chunkedResult);
    await waitForRemoteBackupQueueIdleForTests();

    expect(mockedUploadChunkedBackupToR2).toHaveBeenCalledTimes(3);
    expect(mockedUploadChunkedBackupToR2).toHaveBeenNthCalledWith(1, expect.any(Object), {
      reason: 'first-write',
      writeSnapshot: false,
      writeLatest: undefined,
    });
    expect(mockedUploadChunkedBackupToR2).toHaveBeenNthCalledWith(2, expect.any(Object), {
      reason: 'stale-middle-write',
      writeSnapshot: false,
      writeLatest: undefined,
    });
    expect(mockedUploadChunkedBackupToR2).toHaveBeenNthCalledWith(3, expect.any(Object), {
      reason: 'latest-write',
      writeSnapshot: false,
      writeLatest: undefined,
    });
  });

  it('does not produce an unhandled rejection when a queued drain cannot start, and keeps the task retryable', async () => {
    const dataRoot = process.env.BLOG_DATA_ROOT as string;

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('retryable'));
    const drainLockPath = holdDrainLock(dataRoot);
    const unhandled = collectUnhandledRejections();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await queueCurrentBackupToRemote({ reason: 'held-drain-write' })).toEqual(
        expect.objectContaining({ queued: true })
      );

      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          '[editor-remote-backup] Failed to drain pending backups:',
          expect.stringContaining('Error')
        );
      }, { timeout: 20_000 });
    } finally {
      unhandled.stop();
      consoleError.mockRestore();
      releaseDrainLock(drainLockPath);
    }

    expect(unhandled.reasons).toEqual([]);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Timed out while waiting for the pending backup drain lock');
    expect(await getRemoteBackupQueueStatus()).toEqual({ pending: 1, failed: 0, failedTasks: [] });

    await drainPendingBackups();

    expect(await getRemoteBackupQueueStatus()).toEqual({ pending: 0, failed: 0, failedTasks: [] });
    expect(mockedUploadChunkedBackupToR2).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does not produce an unhandled rejection when a retry-triggered drain cannot start', async () => {
    const dataRoot = process.env.BLOG_DATA_ROOT as string;

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('retried'));
    fs.writeFileSync(getPendingBackupFilePath(dataRoot), JSON.stringify({
      version: 2,
      tasks: [
        {
          id: 'failed-before-retry',
          reason: 'queued-write',
          timestamp: '2026-06-19T00:00:00.000Z',
          retries: 3,
          attempts: 3,
          status: 'failed',
          writeSnapshot: false,
          lastError: 'R2 upload failed.',
          lastAttemptAt: '2026-06-19T00:10:00.000Z',
        },
      ],
    }, null, 2), 'utf8');
    const drainLockPath = holdDrainLock(dataRoot);
    const unhandled = collectUnhandledRejections();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await retryFailedRemoteBackups()).toEqual(
        expect.objectContaining({ retried: 1 })
      );

      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          '[editor-remote-backup] Failed to drain pending backups:',
          expect.stringContaining('Error')
        );
      }, { timeout: 20_000 });
    } finally {
      unhandled.stop();
      consoleError.mockRestore();
      releaseDrainLock(drainLockPath);
    }

    expect(unhandled.reasons).toEqual([]);
    expect(await getRemoteBackupQueueStatus()).toEqual({ pending: 1, failed: 0, failedTasks: [] });

    await drainPendingBackups();

    expect(await getRemoteBackupQueueStatus()).toEqual({ pending: 0, failed: 0, failedTasks: [] });
    expect(mockedUploadChunkedBackupToR2).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('keeps raw remote diagnostics available to the authenticated editor queue status', async () => {
    const sensitiveError = 'NoSuchBucket bucket=private-backups x-amz-request-id=ABC';

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('diagnostics'));
    mockedUploadChunkedBackupToR2
      .mockRejectedValueOnce(new Error(sensitiveError))
      .mockRejectedValueOnce(new Error(sensitiveError))
      .mockRejectedValueOnce(new Error(sensitiveError));

    await queueCurrentBackupToRemote({ reason: 'diagnostics-write' });
    await waitForRemoteBackupQueueIdleForTests();

    expect(await getRemoteBackupQueueStatus()).toEqual({
      pending: 0,
      failed: 1,
      failedTasks: [
        expect.objectContaining({
          reason: 'diagnostics-write',
          attempts: 3,
          lastError: sensitiveError,
        }),
      ],
    });
  });

  it('drains a persisted pending backup after a restart', async () => {
    const dataRoot = process.env.BLOG_DATA_ROOT as string;

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('persisted'));

    expect(await queueCurrentBackupToRemote({ reason: 'before-restart' })).toEqual(
      expect.objectContaining({
        queued: true,
      })
    );
    expect(fs.existsSync(getPendingBackupFilePath(dataRoot))).toBe(true);

    await drainPendingBackups();

    expect(mockedUploadChunkedBackupToR2).toHaveBeenCalledWith(expect.any(Object), {
      reason: 'before-restart',
      writeSnapshot: false,
      writeLatest: undefined,
    });
    expect(fs.existsSync(getPendingBackupFilePath(dataRoot))).toBe(false);
  });

  it('keeps failed queued backups visible until they are retried', async () => {
    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    });
    mockedGetR2BackupStatus.mockReturnValue(createConfiguredStatus());
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(createRemoteBackupPackage('failed'));
    mockedUploadChunkedBackupToR2
      .mockRejectedValueOnce(new Error('R2 temporarily unavailable.'))
      .mockRejectedValueOnce(new Error('R2 temporarily unavailable.'))
      .mockRejectedValueOnce(new Error('R2 temporarily unavailable.'))
      .mockResolvedValue(createChunkedUploadResult('retry-success'));

    expect(await queueCurrentBackupToRemote({ reason: 'queued-write' })).toEqual(
      expect.objectContaining({
        queued: true,
      })
    );
    await waitForRemoteBackupQueueIdleForTests();

    expect(await getRemoteBackupQueueStatus()).toEqual({
      pending: 0,
      failed: 1,
      failedTasks: [
        expect.objectContaining({
          reason: 'queued-write',
          attempts: 3,
          lastError: 'R2 temporarily unavailable.',
        }),
      ],
    });

    const retryResult = await retryFailedRemoteBackups();

    expect(retryResult.retried).toBe(1);
    await waitForRemoteBackupQueueIdleForTests();
    expect(await getRemoteBackupQueueStatus()).toEqual({
      pending: 0,
      failed: 0,
      failedTasks: [],
    });
  });

  it('does not write queued snapshots when the current manifest has changed before drain', async () => {
    const queuedManifest = {
      version: 1 as const,
      updatedAt: '2026-05-26T00:00:00.000Z',
      resources: {
        articles: {
          revision: 'queued-articles-revision',
          hash: 'queued-articles-hash',
          updatedAt: '2026-05-26T00:00:00.000Z',
        },
      },
    };
    const changedPayload = {
      ...createBackupPayload('changed'),
      manifest: {
        version: 1 as const,
        updatedAt: '2026-05-26T00:01:00.000Z',
        resources: {
          articles: {
            revision: 'changed-articles-revision',
            hash: 'changed-articles-hash',
            updatedAt: '2026-05-26T00:01:00.000Z',
          },
        },
      },
    };
    const queuedManifestHash = mockedCreateEditorDataManifestHash(queuedManifest);

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: true,
    });
    mockedGetR2BackupStatus.mockReturnValue({
      ...createConfiguredStatus(),
      snapshotOnWrite: true,
    });
    mockedCreateCurrentEditorManifestSnapshotReference.mockReturnValue({
      manifest: queuedManifest,
      manifestHash: queuedManifestHash,
    });
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue({
      payload: changedPayload,
      mediaAssets: [],
    });
    mockedIsSameEditorManifestSnapshot.mockReturnValue(false);

    expect(await queueCurrentBackupToRemote({ reason: 'snapshot-write' })).toEqual(
      expect.objectContaining({
        queued: true,
      })
    );
    await waitForRemoteBackupQueueIdleForTests();

    expect(await getRemoteBackupQueueStatus()).toEqual({
      pending: 0,
      failed: 1,
      failedTasks: [
        expect.objectContaining({
          reason: 'snapshot-write',
          attempts: 3,
          lastError: 'R2 snapshot manifest changed before upload; snapshot was not written.',
        }),
      ],
    });
  });

  it('does not upload media objects when a queued snapshot precondition already failed', async () => {
    const queuedManifest = {
      version: 1 as const,
      updatedAt: '2026-05-26T00:00:00.000Z',
      resources: {
        articles: {
          revision: 'queued-articles-revision',
          hash: 'queued-articles-hash',
          updatedAt: '2026-05-26T00:00:00.000Z',
        },
      },
    };
    const queuedManifestHash = mockedCreateEditorDataManifestHash(queuedManifest);
    const mediaPackage = {
      payload: {
        ...createBackupPayload('changed-with-media'),
        manifest: {
          version: 1 as const,
          updatedAt: '2026-05-26T00:01:00.000Z',
          resources: {
            articles: {
              revision: 'changed-articles-revision',
              hash: 'changed-articles-hash',
              updatedAt: '2026-05-26T00:01:00.000Z',
            },
          },
        },
      },
      mediaAssets: [
        {
          asset: {
            id: 'c'.repeat(64),
            path: `files/2026/06/${'c'.repeat(64)}.png`,
            publicPath: `/media/files/2026/06/${'c'.repeat(64)}.png`,
            mimeType: 'image/png' as const,
            size: 9,
            hash: 'c'.repeat(64),
            createdAt: '2026-06-19T00:00:00.000Z',
            updatedAt: '2026-06-19T00:00:00.000Z',
          },
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]),
        },
      ],
    };

    mockedGetR2BackupConfig.mockReturnValue({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: true,
    });
    mockedGetR2BackupStatus.mockReturnValue({
      ...createConfiguredStatus(),
      snapshotOnWrite: true,
    });
    mockedCreateCurrentEditorManifestSnapshotReference.mockReturnValue({
      manifest: queuedManifest,
      manifestHash: queuedManifestHash,
    });
    mockedCreateCurrentEditorRemoteBackupPackage.mockResolvedValue(mediaPackage);
    mockedIsSameEditorManifestSnapshot.mockReturnValue(false);

    expect(await queueCurrentBackupToRemote({ reason: 'snapshot-write-with-media' })).toEqual(
      expect.objectContaining({
        queued: true,
      })
    );
    await waitForRemoteBackupQueueIdleForTests();

    expect(await getRemoteBackupQueueStatus()).toEqual({
      pending: 0,
      failed: 1,
      failedTasks: [
        expect.objectContaining({
          reason: 'snapshot-write-with-media',
          attempts: 3,
          lastError: 'R2 snapshot manifest changed before upload; snapshot was not written.',
        }),
      ],
    });
  });
});
