import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/ready/route';
import { acquireEditorDataRootLock, releaseEditorDataRootLock } from '@/lib/editor-data-lock';
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

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('ready API', () => {
  it('reports version, writable data root, manifest, and persisted jobs', async () => {
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
        persistedState: expect.objectContaining({
          valid: true,
          jobCounts: { pending: 0, running: 0, failed: 0 },
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

  it('reports corrupt persisted state files without touching or rewriting them', async () => {
    const root = createDataRoot();
    process.env.BLOG_DATA_ROOT = root;
    const watermarkPath = path.join(root, 'workflow', 'backup-state.json');
    const corruptWatermark = '{ "generation": broken';
    const jobPath = path.join(root, 'workflow', 'jobs', 'corrupt-agent-job.json');
    const corruptJob = '{ nope';
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(watermarkPath, corruptWatermark, 'utf8');
    fs.writeFileSync(jobPath, corruptJob, 'utf8');
    const before = fs.readdirSync(root, { recursive: true }).sort();

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.status).toBe('degraded');
    expect(payload.persistedState).toEqual({
      valid: false,
      invalidFiles: [
        { file: 'workflow/backup-state.json', reason: 'invalid backup watermark' },
        { file: 'workflow/jobs/corrupt-agent-job.json', reason: 'invalid JSON' },
      ],
      jobCounts: { pending: 0, running: 0, failed: 0 },
    });
    expect(fs.readFileSync(watermarkPath, 'utf8')).toBe(corruptWatermark);
    expect(fs.readFileSync(jobPath, 'utf8')).toBe(corruptJob);
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  it('answers readiness without waiting on the editor data write lock', async () => {
    const root = createDataRoot();
    process.env.BLOG_DATA_ROOT = root;
    const lock = await acquireEditorDataRootLock(path.resolve(root));

    try {
      const response = await GET();
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.status).toBe('ok');
      expect(payload.persistedState).toEqual({
        valid: true,
        invalidFiles: [],
        jobCounts: { pending: 0, running: 0, failed: 0 },
      });
      expect(fs.existsSync(path.join(root, '.data-write.lock'))).toBe(true);
    } finally {
      releaseEditorDataRootLock(lock);
    }
  });
});
