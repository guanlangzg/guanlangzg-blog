import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/ready/route';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  BLOG_NAVIGATION_DOCKER: process.env.BLOG_NAVIGATION_DOCKER,
  BLOG_NAVIGATION_VERSION: process.env.BLOG_NAVIGATION_VERSION,
  BLOG_NAVIGATION_IMAGE_TAG: process.env.BLOG_NAVIGATION_IMAGE_TAG,
  BLOG_NAVIGATION_REVISION: process.env.BLOG_NAVIGATION_REVISION,
  BLOG_NAVIGATION_BUILD_TIME: process.env.BLOG_NAVIGATION_BUILD_TIME,
};
const tempDirectories: string[] = [];

function createDataRoot(): string {
  const root = createTempDirectory('blog-navigation-ready-');
  tempDirectories.push(root);
  return root;
}

function createBlockedDataRoot(): string {
  const root = createDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('ready API', () => {
  it('reports version, writable data root, manifest, and backup queue status', async () => {
    process.env.BLOG_DATA_ROOT = createDataRoot();
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    process.env.BLOG_NAVIGATION_VERSION = '9.8.7';
    process.env.BLOG_NAVIGATION_IMAGE_TAG = 'v9.8.7';
    process.env.BLOG_NAVIGATION_REVISION = 'abcdef123456';
    process.env.BLOG_NAVIGATION_BUILD_TIME = '2026-06-08T00:00:00Z';

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'ok',
        version: expect.objectContaining({
          displayVersion: 'v9.8.7',
          runtime: 'docker',
        }),
        dataRoot: {
          source: 'env',
          writable: true,
        },
        manifest: expect.objectContaining({
          valid: true,
        }),
        backupQueue: expect.objectContaining({
          pending: 0,
          failed: 0,
        }),
      })
    );
    expect(payload.dataRoot).not.toHaveProperty('path');
    expect(payload.manifest).not.toHaveProperty('path');
  });

  it('returns degraded when the configured data root is blocked by a file path', async () => {
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'degraded',
        dataRoot: expect.objectContaining({
          writable: false,
        }),
      })
    );
  });

  it('keeps readiness ok when only remote backup queue has failed tasks', async () => {
    process.env.BLOG_DATA_ROOT = createDataRoot();
    writeJson(path.join(process.env.BLOG_DATA_ROOT, '.backup-pending.json'), {
      version: 2,
      tasks: [
        {
          id: 'failed-task-1',
          reason: 'remote-restore',
          timestamp: '2026-06-19T00:00:00.000Z',
          retries: 3,
          attempts: 3,
          status: 'failed',
          writeSnapshot: true,
          lastError: 'R2 upload failed.',
          lastAttemptAt: '2026-06-19T00:10:00.000Z',
        },
      ],
    });

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'ok',
        backupQueue: {
          pending: 0,
          failed: 1,
          failedTasks: [
            {
              id: 'failed-task-1',
              reason: 'remote-restore',
              attempts: 3,
              lastAttemptAt: '2026-06-19T00:10:00.000Z',
              lastError: 'R2 upload failed.',
            },
          ],
        },
      })
    );
  });

  it('keeps readiness ok when remote backup queue state is unreadable', async () => {
    process.env.BLOG_DATA_ROOT = createDataRoot();
    fs.writeFileSync(path.join(process.env.BLOG_DATA_ROOT, '.backup-pending.json'), '{', 'utf8');

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'ok',
        backupQueue: {
          pending: null,
          failed: null,
          failedTasks: [],
          message: 'Pending backup queue state is invalid.',
        },
      })
    );
  });
});
