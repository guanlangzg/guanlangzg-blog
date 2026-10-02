import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/data/media/route';
import { GET as GET_MEDIA } from '@/app/media/[...path]/route';
import { POST as loginEditor } from '@/app/api/editor-auth/route';
import { EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER, EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';
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

  it('stores uploaded images locally, serves them, and queues a JSON backup sync', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
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
    // The legacy /media path reads the working copy, so only an authenticated admin may
    // read it and the response must not be cached by a shared proxy.
    expect(anonymousFileResponse.status).toBe(401);
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
