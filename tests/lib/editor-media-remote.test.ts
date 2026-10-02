import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeEditorMediaRestoreDataFromR2,
  restoreEditorMediaAssetsFromR2,
} from '@/lib/editor-media-remote';
import type { EditorMediaAsset, EditorMediaManifest } from '@/lib/editor-media-storage';
import { cleanupTempDirectories, createTempDirectory, restoreEnv } from '../helpers/api-route';

vi.mock('@/lib/r2-backup-storage', () => ({
  downloadMediaAssetFromR2: vi.fn(),
}));

const { downloadMediaAssetFromR2 } = await import('@/lib/r2-backup-storage');
const mockedDownloadMediaAssetFromR2 = vi.mocked(downloadMediaAssetFromR2);

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
};
const tempDirectories: string[] = [];
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BYTES_ALT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-media-remote-');
  tempDirectories.push(directory);
  return directory;
}

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createAsset(bytes: Uint8Array, suffix = ''): EditorMediaAsset {
  const hash = hashOf(bytes);
  return {
    id: hash,
    path: `files/2026/06/${hash}${suffix}.png`,
    publicPath: `/media/files/2026/06/${hash}${suffix}.png`,
    mimeType: 'image/png',
    size: bytes.byteLength,
    hash,
    createdAt: '2026-06-17T08:00:00.000Z',
    updatedAt: '2026-06-17T08:00:00.000Z',
  };
}

function createManifest(assets: EditorMediaAsset[]): EditorMediaManifest {
  return {
    version: 1,
    updatedAt: '2026-06-17T08:00:00.000Z',
    assets,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('restoreEditorMediaAssetsFromR2', () => {
  it('materializes a complete inline media snapshot from local disk and R2', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const localAsset = createAsset(PNG_BYTES, '-local');
    const remoteAsset = createAsset(PNG_BYTES_ALT, '-remote');
    const { writeRestoredEditorMediaFile } = await import('@/lib/editor-media-storage');

    await writeRestoredEditorMediaFile(localAsset, PNG_BYTES);
    mockedDownloadMediaAssetFromR2.mockImplementation(async (asset: EditorMediaAsset) => {
      if (asset.path === remoteAsset.path) {
        return PNG_BYTES_ALT;
      }

      throw new Error(`Unexpected download: ${asset.path}`);
    });

    const result = await materializeEditorMediaRestoreDataFromR2(createManifest([localAsset, remoteAsset]));

    expect(result.result).toEqual({
      total: 2,
      restored: 1,
      skipped: 1,
      failed: 0,
      failures: [],
    });
    expect(result.media?.manifest).toEqual(createManifest([localAsset, remoteAsset]));
    expect(result.media?.files).toHaveLength(2);
    expect(result.media?.files[0]?.path).toBe(localAsset.path);
    expect(new Uint8Array(result.media?.files[0]?.bytes ?? [])).toEqual(PNG_BYTES);
    expect(result.media?.files[1]?.path).toBe(remoteAsset.path);
    expect(new Uint8Array(result.media?.files[1]?.bytes ?? [])).toEqual(PNG_BYTES_ALT);
  });

  it('throws when a complete inline media snapshot cannot be materialized from R2', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const missingAsset = createAsset(PNG_BYTES, '-missing');
    const corruptAsset = createAsset(PNG_BYTES_ALT, '-corrupt');

    mockedDownloadMediaAssetFromR2.mockImplementation(async (asset: EditorMediaAsset) => {
      if (asset.path === missingAsset.path) {
        throw new Error('NoSuchKey: object not found.');
      }

      return new Uint8Array([0x00, 0x01, 0x02]);
    });

    await expect(
      materializeEditorMediaRestoreDataFromR2(createManifest([missingAsset, corruptAsset]))
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'EditorMediaRestoreDownloadError',
        result: {
          total: 2,
          restored: 0,
          skipped: 0,
          failed: 2,
          failures: [
            {
              path: missingAsset.path,
              message: 'NoSuchKey: object not found.',
            },
            expect.objectContaining({
              path: corruptAsset.path,
            }),
          ],
        },
      })
    );
  });

  it('returns an empty result when manifest is undefined', async () => {
    const result = await restoreEditorMediaAssetsFromR2(undefined);

    expect(result).toEqual({
      total: 0,
      restored: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(mockedDownloadMediaAssetFromR2).not.toHaveBeenCalled();
  });

  it('skips assets already present locally with matching hash', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const asset = createAsset(PNG_BYTES);
    const { writeRestoredEditorMediaFile } = await import('@/lib/editor-media-storage');
    await writeRestoredEditorMediaFile(asset, PNG_BYTES);

    const result = await restoreEditorMediaAssetsFromR2(createManifest([asset]));

    expect(result).toEqual({
      total: 1,
      restored: 0,
      skipped: 1,
      failed: 0,
      failures: [],
    });
    expect(mockedDownloadMediaAssetFromR2).not.toHaveBeenCalled();
  });

  it('records a failure when R2 download throws (missing object)', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const asset = createAsset(PNG_BYTES);
    mockedDownloadMediaAssetFromR2.mockRejectedValue(new Error('NoSuchKey: object not found.'));

    const result = await restoreEditorMediaAssetsFromR2(createManifest([asset]));

    expect(result.total).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        path: asset.path,
        message: 'NoSuchKey: object not found.',
      }),
    ]);
  });

  it('records a failure when downloaded bytes hash does not match asset hash', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const asset = createAsset(PNG_BYTES);
    mockedDownloadMediaAssetFromR2.mockResolvedValue(PNG_BYTES_ALT);

    const result = await restoreEditorMediaAssetsFromR2(createManifest([asset]));

    expect(result.total).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].path).toBe(asset.path);
    expect(result.failures[0].message).toContain(asset.path);
  });

  it('restores some assets and fails others in a mixed batch', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const okAsset = createAsset(PNG_BYTES, '-ok');
    const missingAsset = createAsset(PNG_BYTES_ALT, '-missing');
    const corruptAsset = createAsset(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]), '-corrupt');

    mockedDownloadMediaAssetFromR2.mockImplementation(async (asset: EditorMediaAsset) => {
      if (asset.path === okAsset.path) {
        return PNG_BYTES;
      }
      if (asset.path === missingAsset.path) {
        throw new Error('NoSuchKey: object not found.');
      }
      return new Uint8Array([0x00, 0x01, 0x02]);
    });

    const result = await restoreEditorMediaAssetsFromR2(
      createManifest([okAsset, missingAsset, corruptAsset])
    );

    expect(result.total).toBe(3);
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.failures.map((f) => f.path).sort()).toEqual(
      [corruptAsset.path, missingAsset.path].sort()
    );
  });
});
