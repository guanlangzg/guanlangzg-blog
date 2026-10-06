import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@/lib/jobs/store';
import {
  drainPendingBackups,
  queueCurrentBackupToRemote,
} from '@/lib/editor-remote-backup';
import {
  verifyEditorMediaStorageConsistency,
} from '@/lib/editor-media-storage';
import {
  resetServerStartupTasksForTests,
  SCHEDULED_REMOTE_BACKUP_INTERVAL_MS,
  startServerStartupTasks,
} from '@/lib/startup-tasks';
import { createConfiguredGitHubBackupClient, createGitHubBackupJobHandler } from '@/lib/github/backup-service';
import { getRuntimeInstanceLeasePath } from '@/lib/runtime-instance-lease';

const { runJobWorkerLoopMock } = vi.hoisted(() => ({ runJobWorkerLoopMock: vi.fn() }));

vi.mock('@/lib/jobs/worker', () => ({
  runJobWorkerLoop: runJobWorkerLoopMock,
}));

vi.mock('@/lib/github/backup-service', () => ({
  createConfiguredGitHubBackupClient: vi.fn(async () => ({})),
  createGitHubBackupJobHandler: vi.fn(() => async (_job: JobRecord): Promise<{ remoteCommit: string; verifiedFullBackup?: true }> => ({
    remoteCommit: 'f'.repeat(40),
  })),
}));

vi.mock('@/lib/editor-runtime/pages-runtime', () => ({
  createPagesJobHandlers: vi.fn(() => ({
    publish: vi.fn(async (_job: JobRecord) => undefined),
    reconcile: vi.fn(async (_job: JobRecord) => undefined),
  })),
}));


vi.mock('@/lib/editor-remote-backup', () => ({
  drainPendingBackups: vi.fn(async () => undefined),
  queueCurrentBackupToRemote: vi.fn(() => ({
    queued: true,
    enabled: true,
    success: null,
    message: 'R2 backup sync has been queued.',
  })),
}));

vi.mock('@/lib/editor-media-storage', () => ({
  verifyEditorMediaStorageConsistency: vi.fn(async () => ({
    checkedAssets: 0,
    checkedFiles: 0,
    missingFiles: [],
    hashMismatches: [],
    orphanFiles: [],
  })),
}));

const mockedDrainPendingBackups = vi.mocked(drainPendingBackups);
const mockedQueueCurrentBackupToRemote = vi.mocked(queueCurrentBackupToRemote);
const mockedVerifyEditorMediaStorageConsistency = vi.mocked(verifyEditorMediaStorageConsistency);
const mockedCreateConfiguredGitHubBackupClient = vi.mocked(createConfiguredGitHubBackupClient);
const mockedCreateGitHubBackupJobHandler = vi.mocked(createGitHubBackupJobHandler);

let originalBlogDataRoot: string | undefined;
let isolatedDataRoot: string;

beforeEach(() => {
  originalBlogDataRoot = process.env.BLOG_DATA_ROOT;
  isolatedDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlangzg-startup-tasks-'));
  process.env.BLOG_DATA_ROOT = isolatedDataRoot;
  vi.useFakeTimers();
  resetServerStartupTasksForTests();
  vi.clearAllMocks();
  runJobWorkerLoopMock.mockReset();
  mockedCreateConfiguredGitHubBackupClient.mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof createConfiguredGitHubBackupClient>>);
  mockedCreateGitHubBackupJobHandler.mockReset().mockReturnValue(
    async (_job: JobRecord): Promise<{ remoteCommit: string; verifiedFullBackup?: true }> => ({ remoteCommit: 'f'.repeat(40) })
  );
});

afterEach(() => {
  resetServerStartupTasksForTests();
  vi.useRealTimers();
  if (originalBlogDataRoot === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = originalBlogDataRoot;
  }
  fs.rmSync(isolatedDataRoot, { recursive: true, force: true });
});

describe('server startup tasks', () => {
  it('starts one stoppable worker with Pages publishing and backup handlers', async () => {
    startServerStartupTasks();
    startServerStartupTasks();

    // Real-clock budget: the worker start resolves a chain of dynamic imports, and
    // vi.waitFor measures its timeout with real timers even under fake timers.
    await vi.waitFor(() => {
      expect(runJobWorkerLoopMock).toHaveBeenCalledOnce();
    }, { timeout: 10_000 });

    const workerOptions = runJobWorkerLoopMock.mock.calls[0]?.[0] as {
      handlers: Record<string, unknown>;
      signal: AbortSignal;
    };
    expect(Object.keys(workerOptions.handlers)).toEqual(['github-check', 'build', 'publish', 'reconcile', 'backup']);
    expect(workerOptions.handlers['github-check']).toBeDefined();
    expect(workerOptions.handlers.build).toBeDefined();
    expect(workerOptions.handlers.publish).toBeDefined();
    expect(workerOptions.handlers.reconcile).toBeDefined();
    expect(workerOptions.handlers.backup).toBeDefined();
    expect(workerOptions.signal.aborted).toBe(false);
    expect(mockedCreateGitHubBackupJobHandler).toHaveBeenCalledOnce();

    resetServerStartupTasksForTests();

    expect(workerOptions.signal.aborted).toBe(true);
  });

  it('releases the runtime instance lease when the process is asked to shut down', () => {
    const leasePath = getRuntimeInstanceLeasePath(isolatedDataRoot);

    startServerStartupTasks();
    expect(fs.existsSync(leasePath)).toBe(true);

    process.emit('SIGTERM', 'SIGTERM');

    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it('drains pending remote backup tasks on startup', async () => {
    startServerStartupTasks();

    await vi.waitFor(() => {
      expect(mockedDrainPendingBackups).toHaveBeenCalledOnce();
    });
  });

  it('queues a full remote backup every three hours without duplicate timers', async () => {
    startServerStartupTasks();
    startServerStartupTasks();

    await vi.advanceTimersByTimeAsync(SCHEDULED_REMOTE_BACKUP_INTERVAL_MS);

    await vi.waitFor(() => {
      expect(mockedDrainPendingBackups).toHaveBeenCalledOnce();
      expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledOnce();
    });

    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'scheduled-3h',
      writeLatest: true,
      writeSnapshot: true,
    });
  });

  it('warns when scheduled remote backup cannot be queued while R2 is enabled', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockedQueueCurrentBackupToRemote.mockResolvedValueOnce({
      queued: false,
      enabled: true,
      success: false,
      message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
      invalidConfiguration: true,
    });

    startServerStartupTasks();
    await vi.advanceTimersByTimeAsync(SCHEDULED_REMOTE_BACKUP_INTERVAL_MS);

    await vi.waitFor(() => {
      expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledOnce();
      expect(consoleWarn).toHaveBeenCalledWith(
        '[startup-tasks] Scheduled remote backup was not queued:',
        'Cloudflare R2 配置文件损坏，请修复或删除后重试。'
      );
    });
  });

  it('does not warn when scheduled remote backup is disabled explicitly', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockedQueueCurrentBackupToRemote.mockResolvedValueOnce({
      queued: false,
      enabled: false,
      success: false,
      message: 'R2 backup is disabled.',
    });

    startServerStartupTasks();
    await vi.advanceTimersByTimeAsync(SCHEDULED_REMOTE_BACKUP_INTERVAL_MS);

    await vi.waitFor(() => {
      expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledOnce();
    });

    expect(consoleWarn).not.toHaveBeenCalledWith(
      '[startup-tasks] Scheduled remote backup was not queued:',
      expect.anything()
    );
  });

  it('verifies media storage consistency on startup and only warns on drift', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedVerifyEditorMediaStorageConsistency.mockResolvedValueOnce({
      checkedAssets: 1,
      checkedFiles: 2,
      missingFiles: ['files/2026/06/missing.png'],
      hashMismatches: [],
      orphanFiles: ['files/2026/06/orphan.png'],
    });

    startServerStartupTasks();

    await vi.waitFor(() => {
      expect(mockedVerifyEditorMediaStorageConsistency).toHaveBeenCalledOnce();
      expect(consoleWarn).toHaveBeenCalledWith(
        '[startup-tasks] Media storage consistency issues detected:',
        expect.objectContaining({
          missingFiles: ['files/2026/06/missing.png'],
          orphanFiles: ['files/2026/06/orphan.png'],
        })
      );
      expect(mockedDrainPendingBackups).toHaveBeenCalledOnce();
    });
  });
});
