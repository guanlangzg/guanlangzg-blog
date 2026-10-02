import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import type { CurrentEditorRemoteBackupPackage } from '@/lib/editor-data-backup';
import type { EditorMediaAsset } from '@/lib/editor-media-storage';
import {
  createChunkedBackupFullKeyForTests,
  materializeLatestChunkedBackupFromR2,
  uploadChunkedBackupToR2,
} from '@/lib/r2-chunked-backup-storage';
import { EditorMediaRestoreDownloadError } from '@/lib/editor-media-remote';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { sha256Hex } from '@/lib/stable-json';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  R2_BACKUP_ENABLED: process.env.R2_BACKUP_ENABLED,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_PREFIX: process.env.R2_PREFIX,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
};
const tempDirectories: string[] = [];
const objects = new Map<string, { body: string | Uint8Array; contentType?: string; etag: string }>();
const sentCommands: Array<GetObjectCommand | HeadObjectCommand | PutObjectCommand> = [];
let failPutKeyPattern: RegExp | null = null;
let beforeLatestPut: (() => Promise<void>) | null = null;
let latestPutCount = 0;

function normalizeMockBody(body: unknown): string | Uint8Array {
  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body);
  }

  if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  }

  return String(body ?? '');
}

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');

  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(function MockS3Client() {
      return {
        send: vi.fn(async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
          sentCommands.push(command);

          if (command instanceof actual.PutObjectCommand) {
            const key = String(command.input.Key);

            if (failPutKeyPattern?.test(key)) {
              throw new Error(`Injected PUT failure for ${key}`);
            }

            if (key.endsWith('/v2/latest.json')) {
              latestPutCount += 1;
              await beforeLatestPut?.();
            }

            const current = objects.get(key);
            if (command.input.IfNoneMatch === '*' && current) {
              throw new actual.S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 } });
            }
            if (command.input.IfMatch && current?.etag !== command.input.IfMatch) {
              throw new actual.S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 } });
            }

            const body = normalizeMockBody(command.input.Body);
            const etag = `"${Buffer.from(body).toString('base64')}"`;
            objects.set(key, {
              body,
              contentType: command.input.ContentType,
              etag,
            });

            return { ETag: etag };
          }

          if (command instanceof actual.GetObjectCommand) {
            const key = String(command.input.Key);
            const object = objects.get(key);

            if (!object) {
              const error = new actual.S3ServiceException({
                name: 'NoSuchKey',
                $fault: 'client',
                $metadata: {},
              });
              throw error;
            }

            return {
              Body: object.body,
              ContentType: object.contentType,
              ETag: object.etag,
              ContentLength: object.body instanceof Uint8Array
                ? object.body.byteLength
                : Buffer.byteLength(object.body, 'utf8'),
            };
          }

          if (command instanceof actual.HeadObjectCommand) {
            const key = String(command.input.Key);
            const object = objects.get(key);

            if (!object) {
              const error = new actual.S3ServiceException({
                name: 'NotFound',
                $fault: 'client',
                $metadata: {
                  httpStatusCode: 404,
                },
              });
              throw error;
            }

            return {
              ETag: object.etag,
              ContentLength: object.body instanceof Uint8Array
                ? object.body.byteLength
                : Buffer.byteLength(object.body, 'utf8'),
            };
          }

          return {};
        }),
      };
    }),
  };
});

function restoreEnv(): void {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function createTempDataRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-r2-v2-'));
  tempDirectories.push(directory);
  return directory;
}

function configureR2(): void {
  process.env.BLOG_DATA_ROOT = createTempDataRoot();
  process.env.R2_BACKUP_ENABLED = 'true';
  process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
  process.env.R2_BUCKET = 'blog-data';
  process.env.R2_ACCESS_KEY_ID = 'access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
  process.env.R2_PREFIX = 'blog-navigation';
}

function createArticle(id: string, title: string) {
  return {
    id,
    title,
    date: '2026-06-27',
    description: `${title} description`,
    tags: ['test'],
    content: `# ${title}`,
    slug: id,
    createdAt: 1,
    updatedAt: 2,
  };
}

function createMediaAsset(bytes: Uint8Array): EditorMediaAsset {
  const hash = sha256Hex(bytes);

  return {
    id: hash,
    path: `files/2026/06/${hash}.png`,
    publicPath: `/media/files/2026/06/${hash}.png`,
    mimeType: 'image/png',
    size: bytes.byteLength,
    hash,
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  };
}

function createPackage(articleTitles = ['First', 'Second']): CurrentEditorRemoteBackupPackage {
  const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const mediaAsset = createMediaAsset(mediaBytes);

  return {
    payload: {
      version: 1,
      schemaVersion: 1,
      exportedAt: '2026-06-27T00:00:00.000Z',
      source: 'r2',
      persistent: true,
      dataRoot: '/var/lib/blog-navigation',
      manifest: {
        version: 1,
        updatedAt: '2026-06-27T00:00:00.000Z',
        resources: {},
      },
      data: {
        articles: articleTitles.map((title, index) => createArticle(`article-${index + 1}`, title)),
        navigation: [],
        settings: DEFAULT_SITE_SETTINGS,
        media: {
          version: 1,
          updatedAt: '2026-06-27T00:00:00.000Z',
          assets: [mediaAsset],
        },
      },
    },
    mediaAssets: [
      {
        asset: mediaAsset,
        bytes: mediaBytes,
      },
    ],
  };
}

function getJsonObjects() {
  return [...objects.entries()]
    .filter(([, object]) => object.contentType === 'application/json; charset=utf-8');
}

beforeEach(() => {
  configureR2();
  objects.clear();
  sentCommands.length = 0;
  failPutKeyPattern = null;
  beforeLatestPut = null;
  latestPutCount = 0;
  vi.mocked(S3Client).mockClear();
});

afterEach(() => {
  restoreEnv();

  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('R2 v2 chunked backup storage', () => {
  it('uploads plaintext JSON indexes with one object per article and one object per image', async () => {
    const result = await uploadChunkedBackupToR2(createPackage(), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });

    expect(result.format).toBe('v2-chunked');
    expect(result.latestKey).toBe('blog-navigation/v2/latest.json');
    expect(result.counts).toEqual({
      articles: 2,
      categories: 0,
      media: 1,
    });
    expect([...objects.keys()].filter((key) => key.includes('/v2/objects/articles/'))).toHaveLength(2);
    expect([...objects.keys()].filter((key) => key.includes('/v2/media/'))).toHaveLength(1);

    for (const [, object] of getJsonObjects()) {
      expect(() => JSON.parse(String(object.body))).not.toThrow();
      expect(String(object.body)).not.toContain('passphrase');
      expect(String(object.body)).not.toContain('encryption');
    }
  });

  it('uses the upload cache so unchanged articles are not uploaded again', async () => {
    await uploadChunkedBackupToR2(createPackage(['First', 'Second']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });

    sentCommands.length = 0;
    await uploadChunkedBackupToR2(createPackage(['First changed', 'Second']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });

    const articlePuts = sentCommands
      .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand)
      .filter((command) => String(command.input.Key).includes('/v2/objects/articles/'));

    expect(articlePuts).toHaveLength(1);
  });

  it('reuploads cached immutable objects when they are missing from R2', async () => {
    await uploadChunkedBackupToR2(createPackage(['First', 'Second']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });

    objects.clear();
    sentCommands.length = 0;

    await uploadChunkedBackupToR2(createPackage(['First', 'Second']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });

    const articlePuts = sentCommands
      .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand)
      .filter((command) => String(command.input.Key).includes('/v2/objects/articles/'));

    expect(articlePuts).toHaveLength(2);
  });

  it('restores a complete snapshot and fails when a referenced media object is missing', async () => {
    const upload = await uploadChunkedBackupToR2(createPackage(['Restored']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });
    const restored = await materializeLatestChunkedBackupFromR2();

    expect(restored.snapshotId).toBe(upload.snapshotId);
    expect(restored.data.articles).toEqual([
      expect.objectContaining({
        id: 'article-1',
        title: 'Restored',
      }),
    ]);
    expect(restored.mediaRestore).toEqual({
      total: 1,
      restored: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });

    const mediaPath = restored.data.media?.manifest.assets[0]?.path;
    if (!mediaPath || !restored.data.media?.readFile) {
      throw new Error('Expected lazily readable media asset.');
    }

    await expect(restored.data.media.readFile(mediaPath)).resolves.toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(restored.mediaRestore).toEqual({
      total: 1,
      restored: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });

    const mediaKey = [...objects.keys()].find((key) => key.includes('/v2/media/'));

    if (!mediaKey) {
      throw new Error('Expected uploaded media object.');
    }

    objects.delete(mediaKey);
    const missingMediaRestore = await materializeLatestChunkedBackupFromR2();
    await expect(missingMediaRestore.data.media?.readFile?.(mediaPath)).rejects.toBeInstanceOf(EditorMediaRestoreDownloadError);
    expect(missingMediaRestore.mediaRestore).toEqual({
      total: 1,
      restored: 0,
      skipped: 0,
      failed: 1,
      failures: [expect.objectContaining({ path: mediaPath })],
    });
  });

  it('does not let an older upload replace a newer latest pointer', async () => {
    let signalFirstLatest!: () => void;
    let releaseFirstLatest!: () => void;
    const firstLatestReached = new Promise<void>((resolve) => { signalFirstLatest = resolve; });
    const firstLatestGate = new Promise<void>((resolve) => { releaseFirstLatest = resolve; });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    beforeLatestPut = async () => {
      if (latestPutCount === 1) {
        signalFirstLatest();
        await firstLatestGate;
      }
    };

    const olderUpload = uploadChunkedBackupToR2(createPackage(['Older']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });
    await firstLatestReached;
    vi.setSystemTime(new Date('2026-10-02T12:00:02.000Z'));
    const newer = await uploadChunkedBackupToR2(createPackage(['Newer']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });
    releaseFirstLatest();
    await olderUpload;
    vi.useRealTimers();

    const latestKey = createChunkedBackupFullKeyForTests({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    }, 'v2/latest.json');
    const latest = JSON.parse(String(objects.get(latestKey)?.body)) as { snapshotId: string };

    expect(latest.snapshotId).toBe(newer.snapshotId);
  });

  it('uses the snapshot ID as a deterministic tie-breaker for identical timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
    const first = await uploadChunkedBackupToR2(createPackage(['First']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });
    const second = await uploadChunkedBackupToR2(createPackage(['Second']), {
      reason: 'manual-sync',
      writeSnapshot: true,
    });
    vi.useRealTimers();

    const latestKey = createChunkedBackupFullKeyForTests({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    }, 'v2/latest.json');
    const latest = JSON.parse(String(objects.get(latestKey)?.body)) as { snapshotId: string };

    expect(latest.snapshotId).toBe([first.snapshotId, second.snapshotId].sort().at(-1));
  });

  it('does not write the latest pointer when immutable object upload fails', async () => {
    failPutKeyPattern = /\/v2\/objects\/articles\//;

    await expect(uploadChunkedBackupToR2(createPackage(), {
      reason: 'manual-sync',
      writeSnapshot: true,
    })).rejects.toThrow('Injected PUT failure');

    const latestKey = createChunkedBackupFullKeyForTests({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    }, 'v2/latest.json');

    expect(objects.has(latestKey)).toBe(false);
  });
});
