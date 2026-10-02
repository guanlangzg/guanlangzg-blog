import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditorMediaInvalidFileError,
  getMediaManifestFilePath,
  parseEditorMediaManifest,
  readEditorMediaManifest,
  storeEditorMediaFile,
  verifyEditorMediaStorageConsistency,
} from '@/lib/editor-media-storage';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
};
const tempDirectories: string[] = [];
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-media-storage-');
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('editor media storage', () => {
  it('stores image files by content hash and writes a JSON manifest', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const first = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-17T08:00:00.000Z'),
    });
    const second = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-17T09:00:00.000Z'),
    });
    const manifest = readEditorMediaManifest();

    expect(first.asset.path).toMatch(/^files\/2026\/06\/[a-f0-9]{64}\.png$/);
    expect(first.asset.publicPath).toBe(`/media/${first.asset.path}`);
    expect(first.created).toBe(true);
    expect(second.asset.path).toBe(first.asset.path);
    expect(second.created).toBe(false);
    expect(fs.existsSync(first.filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(getMediaManifestFilePath(), 'utf8'))).toEqual(manifest);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toEqual(
      expect.objectContaining({
        id: first.asset.id,
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
      })
    );
  });

  it('reports missing, corrupted, and orphaned media files', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const stored = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-17T08:00:00.000Z'),
    });
    const cleanReport = await verifyEditorMediaStorageConsistency();

    expect(cleanReport).toEqual({
      checkedAssets: 1,
      checkedFiles: 1,
      missingFiles: [],
      hashMismatches: [],
      orphanFiles: [],
    });

    fs.unlinkSync(stored.filePath);
    await expect(verifyEditorMediaStorageConsistency()).resolves.toEqual(
      expect.objectContaining({
        missingFiles: [stored.asset.path],
      })
    );

    fs.writeFileSync(stored.filePath, new Uint8Array([0x00, 0x01, 0x02]));
    const orphanPath = path.join(path.dirname(stored.filePath), 'orphan.png');
    fs.writeFileSync(orphanPath, PNG_BYTES);

    await expect(verifyEditorMediaStorageConsistency()).resolves.toEqual(
      expect.objectContaining({
        hashMismatches: [stored.asset.path],
        orphanFiles: [
          stored.asset.path.replace(/[^/]+$/, 'orphan.png'),
        ],
      })
    );
  });

  it('rewrites an existing media file when its hash or size no longer matches the manifest', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const stored = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-17T08:00:00.000Z'),
    });

    fs.writeFileSync(stored.filePath, new Uint8Array([0x00, 0x01, 0x02]));

    const rewritten = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-17T09:00:00.000Z'),
    });

    expect(rewritten.filePath).toBe(stored.filePath);
    expect(fs.readFileSync(stored.filePath)).toEqual(Buffer.from(PNG_BYTES));
    await expect(verifyEditorMediaStorageConsistency()).resolves.toEqual(
      expect.objectContaining({
        hashMismatches: [],
      })
    );
  });

  it('rejects unsupported file types and unsafe manifests', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    await expect(storeEditorMediaFile({
      bytes: new Uint8Array([0x41, 0x42, 0x43]),
    })).rejects.toBeInstanceOf(EditorMediaInvalidFileError);

    expect(parseEditorMediaManifest({
      version: 1,
      updatedAt: '2026-06-17T08:00:00.000Z',
      assets: [
        {
          id: 'a'.repeat(64),
          path: '../secret.png',
          publicPath: '/media/../secret.png',
          mimeType: 'image/png',
          size: 1,
          hash: 'a'.repeat(64),
          createdAt: '2026-06-17T08:00:00.000Z',
          updatedAt: '2026-06-17T08:00:00.000Z',
        },
      ],
    })).toBeNull();
  });

  it('removes a newly written file when manifest persistence fails', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const mediaModule = await import('@/lib/editor-media-storage');
    const manifestPath = getMediaManifestFilePath();
    const renameSync = fs.renameSync;

    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(newPath) === manifestPath) {
        throw new Error('Simulated manifest write failure.');
      }

      return renameSync.call(fs, oldPath, newPath);
    }) as typeof fs.renameSync;

    try {
      await expect(mediaModule.storeEditorMediaFile({
        bytes: PNG_BYTES,
        now: new Date('2026-06-17T08:00:00.000Z'),
      })).rejects.toThrow('Simulated manifest write failure.');
    } finally {
      fs.renameSync = renameSync;
    }

    const filesRoot = path.join(path.dirname(manifestPath), 'files');
    expect(fs.existsSync(filesRoot)).toBe(true);
    expect(fs.readdirSync(filesRoot, { recursive: true }).filter((entry) => String(entry).endsWith('.png')).length).toBe(0);
  });
});
