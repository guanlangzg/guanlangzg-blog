import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/data/media/gc/route';
import { storeEditorMediaFile } from '@/lib/editor-media-storage';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/editor-remote-backup', () => ({
  queueCurrentBackupToRemote: vi.fn(),
}));

vi.mock('@/lib/r2-backup-storage', () => ({
  uploadMediaAssetToR2: vi.fn(),
}));

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const tempDirectories: string[] = [];
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-media-gc-route-');
  tempDirectories.push(directory);
  return directory;
}

function writeOrphanFile(dataRoot: string, fileName: string, bytes = PNG_BYTES): void {
  const orphanPath = path.join(dataRoot, 'media', 'files', '2026', '06', fileName);

  fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
  fs.writeFileSync(orphanPath, bytes);
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  vi.clearAllMocks();
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('media GC API', () => {
  it('rejects unauthenticated GC requests', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(new NextRequest('http://localhost/api/data/media/gc', {
      method: 'POST',
    }));

    expect(response.status).toBe(401);
  });

  it('deletes orphan media files and keeps referenced ones', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;

    const stored = await storeEditorMediaFile({ bytes: PNG_BYTES });
    const orphanFileName = `${hashOf(new Uint8Array([0xaa, 0xbb, 0xcc]))}.png`;
    const orphanPath = path.join(dataRoot, 'media', 'files', '2026', '06', orphanFileName);

    writeOrphanFile(dataRoot, orphanFileName, new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect(fs.existsSync(orphanPath)).toBe(true);

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media/gc', {
        method: 'POST',
      })
    );
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        deleted: 1,
        freedBytes: 3,
      })
    );
    expect(fs.existsSync(orphanPath)).toBe(false);

    const referencedPath = path.join(dataRoot, 'media', stored.asset.path);

    expect(fs.existsSync(referencedPath)).toBe(true);
  });

  it('does not delete non-managed files inside the media directory', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;

    writeOrphanFile(dataRoot, 'notes.txt', new TextEncoder().encode('keep me'));

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media/gc', {
        method: 'POST',
      })
    );
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        deleted: 0,
        freedBytes: 0,
      })
    );
    expect(fs.existsSync(path.join(dataRoot, 'media', 'files', '2026', '06', 'notes.txt'))).toBe(true);
  });

  it('reports no deletions when there are no orphan files', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;

    await storeEditorMediaFile({ bytes: PNG_BYTES });

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media/gc', {
        method: 'POST',
      })
    );
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        deleted: 0,
        freedBytes: 0,
      })
    );
  });
});
