import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/data/media/route';
import { GET as GET_MEDIA } from '@/app/media/[...path]/route';
import { POST as loginEditor } from '@/app/api/editor-auth/route';
import { EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER, EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { writeLivePointer, writeRelease } from '@/lib/publishing/store';
import type { SiteSnapshot } from '@/lib/publishing/types';
import { EDITOR_MEDIA_MAX_IMAGE_BYTES } from '@/lib/editor-media-storage';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/editor-remote-backup', () => ({
  queueCurrentBackupToRemote: vi.fn(),
}));

const mockedQueueCurrentBackupToRemote = vi.mocked(queueCurrentBackupToRemote);
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  BLOG_NAVIGATION_DOCKER: process.env.BLOG_NAVIGATION_DOCKER,
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const tempDirectories: string[] = [];
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BYTES_ALT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-media-route-');
  tempDirectories.push(directory);
  return directory;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

function createImageUpload(bytes = PNG_BYTES): { body: BodyInit; headers: HeadersInit } {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );

  return {
    body,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
    },
  };
}

async function createSharedSessionRequests(
  url: string,
  uploads: { body: BodyInit; headers: HeadersInit }[]
): Promise<NextRequest[]> {
  const loginResponse = await loginEditor(new NextRequest('http://localhost/api/editor-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: process.env.EDITOR_ACCESS_TOKEN ?? '' }),
  }));
  const setCookie = loginResponse.headers.get('set-cookie') ?? '';
  const sessionCookie = setCookie.split(';')[0] ?? '';
  const csrfCookie = setCookie
    .split(',')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${EDITOR_CSRF_COOKIE}=`))
    ?.split(';')[0] ?? '';
  const csrfToken = csrfCookie.slice(`${EDITOR_CSRF_COOKIE}=`.length);

  if (loginResponse.status !== 200 || !sessionCookie.startsWith(`${EDITOR_SESSION_COOKIE}=`)) {
    throw new Error(`Failed to create shared editor session: status=${loginResponse.status}`);
  }

  return uploads.map((upload) => {
    const headers = new Headers(upload.headers);
    headers.set('Cookie', csrfCookie ? `${sessionCookie}; ${csrfCookie}` : sessionCookie);
    headers.set(EDITOR_CSRF_HEADER, csrfToken);
    headers.set('Origin', 'http://localhost');

    return new NextRequest(url, {
      method: 'POST',
      body: upload.body,
      headers,
    });
  });
}

async function createAuthenticatedHeaders(): Promise<Headers> {
  const currentRoot = process.env.BLOG_DATA_ROOT;

  process.env.BLOG_DATA_ROOT = createTempDataRoot();

  try {
    const request = await createAuthedEditorRequest('http://localhost/api/data/media');

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
  vi.clearAllMocks();
  mockedQueueCurrentBackupToRemote.mockResolvedValue({
    queued: false,
    enabled: false,
    success: false,
    message: 'R2 backup is disabled.',
  });
});

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

function publishLiveMediaRelease(
  asset: { path: string; publicPath: string; hash: string; size: number },
  releaseId: string
): void {
  const snapshot: SiteSnapshot = {
    schemaVersion: 1, siteId: 'media-reader-site',
    articles: [{ id: 'live-article', slug: 'live-article', title: 'Live', date: '', description: '', tags: [], content: `![image](${asset.publicPath})`, createdAt: 1, updatedAt: 1 }],
    navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
    media: [{ originalPath: asset.path, publicPath: asset.publicPath, sha256: asset.hash, size: asset.size, mimeType: 'image/png' }],
    redirects: [], removedPaths: [],
  };
  const candidateDigest = computeCandidateDigest(snapshot);
  const artifactDigest = 'a'.repeat(64);
  const now = '2026-10-05T00:00:00.000Z';

  writeRelease({
    schemaVersion: 1, id: releaseId, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
    selectedRevision: 'b'.repeat(64), candidateDigest, artifactDigest, status: 'live', backupProof: null,
    publicCommitSha: 'c'.repeat(40), workflowRunId: 1, workflowRunAttempt: 1, retryFromAttempt: null,
    error: null, createdAt: now, updatedAt: now,
  }, snapshot);
  writeLivePointer({ schemaVersion: 1, releaseId, candidateDigest, artifactDigest, publicCommitSha: 'c'.repeat(40), workflowRunId: 1, workflowRunAttempt: 1, verifiedAt: now });
}

describe('media API', () => {
  it('rejects unauthenticated uploads', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(new NextRequest('http://localhost/api/data/media', {
      method: 'POST',
      ...createImageUpload(),
    }));

    expect(response.status).toBe(401);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('serves an upload anonymously only after a live release references it', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    vi.stubEnv('NODE_ENV', 'test');
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const upload = await POST(await createAuthedEditorRequest('http://localhost/api/data/media', {
      method: 'POST', ...createImageUpload(),
    }));
    const payload = await upload.json();
    const asset = payload.asset as { path: string; publicPath: string; hash: string; size: number };
    const params = { params: Promise.resolve({ path: asset.path.split('/') }) };
    const hidden = await GET_MEDIA(new NextRequest(`http://localhost${asset.publicPath}`), params);
    const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8')) as {
      assets: Array<{ path: string; hash: string; size: number }>;
    };
    manifest.assets[0] = { ...manifest.assets[0], path: asset.path, hash: asset.hash, size: asset.size };
    fs.writeFileSync(path.join(dataRoot, 'media', 'manifest.json'), JSON.stringify(manifest));
    const snapshot: SiteSnapshot = {
      schemaVersion: 1, siteId: 'media-reader-site',
      articles: [{ id: 'live-article', slug: 'live-article', title: 'Live', date: '', description: '', tags: [], content: `![image](${asset.publicPath})`, createdAt: 1, updatedAt: 1 }],
      navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
      media: [{ originalPath: asset.path, publicPath: asset.publicPath, sha256: asset.hash, size: asset.size, mimeType: 'image/png' }],
      redirects: [], removedPaths: [],
    };
    const releaseId = 'media-reader-release';
    const candidateDigest = computeCandidateDigest(snapshot);
    const artifactDigest = 'a'.repeat(64);
    const now = '2026-10-05T00:00:00.000Z';
    writeRelease({
      schemaVersion: 1, id: releaseId, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
      selectedRevision: 'b'.repeat(64), candidateDigest, artifactDigest, status: 'live', backupProof: null,
      publicCommitSha: 'c'.repeat(40), workflowRunId: 1, workflowRunAttempt: 1, retryFromAttempt: null,
      error: null, createdAt: now, updatedAt: now,
    }, snapshot);
    writeLivePointer({ schemaVersion: 1, releaseId, candidateDigest, artifactDigest, publicCommitSha: 'c'.repeat(40), workflowRunId: 1, workflowRunAttempt: 1, verifiedAt: now });
    const publicResponse = await GET_MEDIA(new NextRequest(`http://localhost${asset.publicPath}`), params);

    expect(hidden.status).toBe(404);
    expect(publicResponse.status).toBe(200);
    expect(new Uint8Array(await publicResponse.arrayBuffer())).toEqual(PNG_BYTES);
    expect(publicResponse.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=600');
  });

  it('refuses an anonymously referenced asset whose working-copy bytes no longer match the live snapshot', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    vi.stubEnv('NODE_ENV', 'test');
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const upload = await POST(await createAuthedEditorRequest('http://localhost/api/data/media', {
      method: 'POST', ...createImageUpload(),
    }));
    const asset = (await upload.json()).asset as { path: string; publicPath: string; hash: string; size: number };
    const manifestPath = path.join(dataRoot, 'media', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      assets: Array<{ path: string; hash: string; size: number }>;
    };
    manifest.assets[0] = { ...manifest.assets[0], path: asset.path, hash: asset.hash, size: asset.size };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    publishLiveMediaRelease(asset, 'media-reader-tampered-release');
    const params = { params: Promise.resolve({ path: asset.path.split('/') }) };

    fs.writeFileSync(path.join(dataRoot, 'media', asset.path), PNG_BYTES_ALT);
    const anonymousResponse = await GET_MEDIA(new NextRequest(`http://localhost${asset.publicPath}`), params);

    expect(PNG_BYTES_ALT.byteLength).toBe(PNG_BYTES.byteLength);
    expect(anonymousResponse.status).toBe(404);
    expect(new Uint8Array(await anonymousResponse.arrayBuffer())).not.toEqual(PNG_BYTES_ALT);
  });

  it('serves a live-referenced asset anonymously when the working manifest no longer lists it', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    vi.stubEnv('NODE_ENV', 'test');
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const upload = await POST(await createAuthedEditorRequest('http://localhost/api/data/media', {
      method: 'POST', ...createImageUpload(),
    }));
    const asset = (await upload.json()).asset as { path: string; publicPath: string; hash: string; size: number };
    // A restore or a manual manifest edit can drop the entry while the published bytes stay on
    // disk; the frozen live release is still the authority for what a reader may fetch.
    fs.rmSync(path.join(dataRoot, 'media', 'manifest.json'), { force: true });
    publishLiveMediaRelease(asset, 'media-reader-manifestless-release');
    const params = { params: Promise.resolve({ path: asset.path.split('/') }) };

    const anonymousResponse = await GET_MEDIA(new NextRequest(`http://localhost${asset.publicPath}`), params);

    expect(anonymousResponse.status).toBe(200);
    expect(new Uint8Array(await anonymousResponse.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('refuses an asset whose bytes and working manifest were rewritten together', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    vi.stubEnv('NODE_ENV', 'test');
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const upload = await POST(await createAuthedEditorRequest('http://localhost/api/data/media', {
      method: 'POST', ...createImageUpload(),
    }));
    const asset = (await upload.json()).asset as { path: string; publicPath: string; hash: string; size: number };
    const manifestPath = path.join(dataRoot, 'media', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      assets: Array<{ id: string; path: string; hash: string; size: number }>;
    };
    const rewrittenHash = createHash('sha256').update(PNG_BYTES_ALT).digest('hex');
    manifest.assets[0] = {
      ...manifest.assets[0],
      id: rewrittenHash,
      path: asset.path,
      hash: rewrittenHash,
      size: PNG_BYTES_ALT.byteLength,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    publishLiveMediaRelease(asset, 'media-reader-rewritten-release');
    const params = { params: Promise.resolve({ path: asset.path.split('/') }) };

    fs.writeFileSync(path.join(dataRoot, 'media', asset.path), PNG_BYTES_ALT);
    const anonymousResponse = await GET_MEDIA(new NextRequest(`http://localhost${asset.publicPath}`), params);

    expect(PNG_BYTES_ALT.byteLength).toBe(PNG_BYTES.byteLength);
    expect(anonymousResponse.status).toBe(404);
    expect(new Uint8Array(await anonymousResponse.arrayBuffer())).not.toEqual(PNG_BYTES_ALT);
  });

  it('stores uploads for editors and never exposes an unreferenced working-copy asset anonymously', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    delete process.env.BLOG_NAVIGATION_DOCKER;
    delete process.env.BLOG_NAVIGATION_DOCKER;
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media', {
        method: 'POST',
        ...createImageUpload(),
      })
    );
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);

    const asset = payload.asset as { path: string; publicPath: string; mimeType: string; hash: string };
    const mediaFile = path.join(process.env.BLOG_DATA_ROOT, 'media', asset.path);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'media', 'manifest.json'), 'utf8')
    );
    const anonymousFileResponse = await GET_MEDIA(
      new NextRequest(`http://localhost${asset.publicPath}`),
      { params: Promise.resolve({ path: asset.path.split('/') }) }
    );
    const fileResponse = await GET_MEDIA(
      await createAuthedEditorRequest(`http://localhost${asset.publicPath}`),
      { params: Promise.resolve({ path: asset.path.split('/') }) }
    );

    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        asset: expect.objectContaining({
          path: expect.stringMatching(/^files\/\d{4}\/\d{2}\/[a-f0-9]{64}\.png$/),
          publicPath: expect.stringMatching(/^\/media\/files\//),
          mimeType: 'image/png',
        }),
      })
    );
    expect(fs.existsSync(mediaFile)).toBe(true);
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        hash: asset.hash,
        path: asset.path,
      }),
    ]);
    // Anonymous access is restricted to assets referenced by the verified live snapshot.
    expect(anonymousFileResponse.status).toBe(404);
    expect(new Uint8Array(await anonymousFileResponse.arrayBuffer())).not.toEqual(PNG_BYTES);
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get('content-type')).toBe('image/png');
    expect(fileResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mockedQueueCurrentBackupToRemote).toHaveBeenCalledWith({
      reason: 'media-write',
      writeSnapshot: false,
    });
  });

  it('rejects non-image uploads before writing files', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media', {
        method: 'POST',
        ...createImageUpload(new Uint8Array([0x41, 0x42, 0x43])),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: 'unsupported_media',
      })
    );
    expect(fs.existsSync(path.join(process.env.BLOG_DATA_ROOT, 'media'))).toBe(false);
  });

  it('rejects oversized uploads from Content-Length before reading image bytes', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const upload = createImageUpload();
    const response = await POST(
      await createAuthedEditorRequest('http://localhost/api/data/media', {
        method: 'POST',
        body: upload.body,
        headers: {
          ...upload.headers,
          'Content-Length': String(EDITOR_MEDIA_MAX_IMAGE_BYTES + 1),
        },
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: 'media_too_large',
      })
    );
    expect(fs.existsSync(path.join(process.env.BLOG_DATA_ROOT, 'media'))).toBe(false);
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('reports a blocked runtime data root instead of returning a raw upload failure', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    const headers = await createAuthenticatedHeaders();

    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const upload = createImageUpload();
    const requestHeaders = new Headers(headers);

    for (const [name, value] of Object.entries(upload.headers)) {
      requestHeaders.set(name, value);
    }

    const response = await POST(new NextRequest('http://localhost/api/data/media', {
      method: 'POST',
      headers: requestHeaders,
      body: upload.body,
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
    expect(mockedQueueCurrentBackupToRemote).not.toHaveBeenCalled();
  });

  it('preserves both assets when two different images are uploaded concurrently', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const [requestA, requestB] = await createSharedSessionRequests(
      'http://localhost/api/data/media',
      [createImageUpload(PNG_BYTES), createImageUpload(PNG_BYTES_ALT)]
    );

    const [responseA, responseB] = await Promise.all([
      POST(requestA),
      POST(requestB),
    ]);
    const [payloadA, payloadB] = await Promise.all([
      responseA.json(),
      responseB.json(),
    ]);

    expect(responseA.status, JSON.stringify(payloadA)).toBe(200);
    expect(responseB.status, JSON.stringify(payloadB)).toBe(200);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'media', 'manifest.json'), 'utf8')
    );
    const assetPaths = manifest.assets.map((asset: { path: string }) => asset.path);

    expect(manifest.assets).toHaveLength(2);
    expect(assetPaths).toEqual(
      expect.arrayContaining([payloadA.asset.path, payloadB.asset.path])
    );
    expect(payloadA.asset.hash).not.toBe(payloadB.asset.hash);
    expect(fs.existsSync(path.join(process.env.BLOG_DATA_ROOT, 'media', payloadA.asset.path))).toBe(true);
    expect(fs.existsSync(path.join(process.env.BLOG_DATA_ROOT, 'media', payloadB.asset.path))).toBe(true);
  });
});
