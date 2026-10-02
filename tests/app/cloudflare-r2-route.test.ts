import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as bootstrapR2 } from '@/app/api/data/cloudflare-r2/bootstrap/route';
import { GET, PUT } from '@/app/api/data/cloudflare-r2/route';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  R2_BACKUP_ENABLED: process.env.R2_BACKUP_ENABLED,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_PREFIX: process.env.R2_PREFIX,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_SNAPSHOT_ON_WRITE: process.env.R2_SNAPSHOT_ON_WRITE,
};
const ORIGINAL_CWD = process.cwd();
const tempDirectories: string[] = [];

function resetEnv(): void {
  restoreEnv(ORIGINAL_ENV);
}

function clearR2Env(): void {
  for (const name of [
    'R2_BACKUP_ENABLED',
    'R2_ACCOUNT_ID',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_PREFIX',
    'R2_ENDPOINT',
    'R2_SNAPSHOT_ON_WRITE',
  ]) {
    delete process.env[name];
  }
}

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-cloudflare-r2-route-');
  tempDirectories.push(directory);
  return directory;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

function getSettingsFile(dataRoot: string): string {
  return path.join(dataRoot, 'settings', 'cloudflare-r2.json');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetEnv();
  process.chdir(ORIGINAL_CWD);
  cleanupTempDirectories(tempDirectories);
});

describe('Cloudflare R2 settings API', () => {
  it('rejects unauthenticated reads and writes', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const getResponse = await GET(new NextRequest('http://localhost/api/data/cloudflare-r2'));
    const putResponse = await PUT(
      new NextRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: false,
          },
        }),
      })
    );

    expect(getResponse.status).toBe(401);
    expect(putResponse.status).toBe(401);
  });

  it('saves settings to the default data directory when BLOG_DATA_ROOT is missing', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    delete process.env.BLOG_DATA_ROOT;
    const tempProjectRoot = createTempDirectory('blog-navigation-r2-default-root-');
    tempDirectories.push(tempProjectRoot);
    process.chdir(tempProjectRoot);

    const response = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            secretAccessKey: '',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: true,
        settings: expect.objectContaining({
          enabled: false,
        }),
      })
    );
    expect(fs.existsSync(path.join(tempProjectRoot, 'data', 'settings', 'cloudflare-r2.json'))).toBe(true);
  });

  it('rejects malformed or non-object settings without writing a settings file', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const malformedResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: '{',
      })
    );
    const arrayResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: [],
        }),
      })
    );
    const settingsFile = path.join(process.env.BLOG_DATA_ROOT, 'settings', 'cloudflare-r2.json');

    expect(malformedResponse.status).toBe(400);
    expect(arrayResponse.status).toBe(400);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('rejects enabled settings with missing credentials without writing secrets', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const response = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: '',
            secretAccessKey: '',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
        }),
      })
    );
    const settingsFile = path.join(process.env.BLOG_DATA_ROOT, 'settings', 'cloudflare-r2.json');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('启用 R2 备份时必须填写'),
      })
    );
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('reports a blocked runtime data root instead of returning a raw filesystem error', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const response = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            secretAccessKey: '',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
  });

  it('reports corrupt stored settings instead of falling back to env settings', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '33333333333333333333333333333333';
    process.env.R2_BUCKET = 'env-bucket';
    process.env.R2_ACCESS_KEY_ID = 'env-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'env-secret-key';
    writeText(getSettingsFile(process.env.BLOG_DATA_ROOT), '{');

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
      })
    );
  });

  it('still returns R2 settings when the remote backup queue state file is corrupt', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    writeText(path.join(process.env.BLOG_DATA_ROOT, '.backup-pending.json'), '{');

    const response = await GET(await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({
          configured: false,
        }),
        backupQueue: null,
        backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
      })
    );
  });

  it('does not replace corrupt stored settings when an enabled update omits the secret', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const settingsFile = getSettingsFile(process.env.BLOG_DATA_ROOT);
    writeText(settingsFile, '{');

    const response = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: 'access-key',
            secretAccessKey: '',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
      })
    );
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{');
  });

  it('replaces corrupt stored settings when a complete enabled update includes the secret', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const settingsFile = getSettingsFile(process.env.BLOG_DATA_ROOT);
    writeText(settingsFile, '{');

    const response = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: 'access-key',
            secretAccessKey: 'replacement-secret',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: true,
          },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(payload)).not.toContain('replacement-secret');
    expect(payload.settings).toEqual(
      expect.objectContaining({
        enabled: true,
        hasSecretAccessKey: true,
      })
    );
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(
      expect.objectContaining({
        secretAccessKey: 'replacement-secret',
        snapshotOnWrite: true,
      })
    );
  });

  it('saves settings without returning the secret and keeps it when omitted later', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const createResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
        }),
      })
    );
    const createPayload = await createResponse.json();

    expect(createResponse.status).toBe(200);
    expect(JSON.stringify(createPayload)).not.toContain('secret-key');
    expect(createPayload.settings).toEqual(
      expect.objectContaining({
        hasSecretAccessKey: true,
      })
    );

    const getResponse = await GET(await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2'));
    const getPayload = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(JSON.stringify(getPayload)).not.toContain('secret-key');

    const updateResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: 'next-access-key',
            secretAccessKey: '',
            prefix: 'next-prefix',
            endpoint: '',
            snapshotOnWrite: true,
          },
          revision: getPayload.revision,
        }),
      })
    );
    const settingsFile = path.join(process.env.BLOG_DATA_ROOT, 'settings', 'cloudflare-r2.json');
    const storedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    expect(updateResponse.status).toBe(200);
    expect(storedSettings).toEqual(
      expect.objectContaining({
        accessKeyId: 'next-access-key',
        secretAccessKey: 'secret-key',
        prefix: 'next-prefix',
        snapshotOnWrite: true,
      })
    );
  });

  it('rejects stale settings revisions without overwriting R2 credentials', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const createResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          revision: null,
        }),
      })
    );
    const createPayload = await createResponse.json();

    expect(createResponse.status).toBe(200);
    expect(createPayload.revision).toEqual(expect.any(String));

    const staleResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'stale-bucket',
            accessKeyId: 'stale-access-key',
            secretAccessKey: 'stale-secret-key',
            prefix: 'stale-prefix',
            endpoint: '',
            snapshotOnWrite: true,
          },
          revision: null,
        }),
      })
    );
    const stalePayload = await staleResponse.json();
    const storedSettings = JSON.parse(fs.readFileSync(getSettingsFile(process.env.BLOG_DATA_ROOT), 'utf8'));

    expect(staleResponse.status).toBe(409);
    expect(stalePayload).toEqual(expect.objectContaining({
      message: 'Cloudflare R2 配置已被其他会话更新，请刷新后重试。',
      revision: createPayload.revision,
    }));
    expect(storedSettings).toEqual(expect.objectContaining({
      bucket: 'blog-data',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      snapshotOnWrite: false,
    }));
  });

  it('returns the latest R2 state when bootstrap is rejected by a stale revision', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const createResponse = await PUT(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            enabled: true,
            accountId: '22222222222222222222222222222222',
            bucket: 'server-bucket',
            accessKeyId: 'server-access-key',
            secretAccessKey: 'server-secret-key',
            prefix: 'server-prefix',
            endpoint: '',
            snapshotOnWrite: true,
          },
          revision: null,
        }),
      })
    );
    const createPayload = await createResponse.json();

    expect(createResponse.status).toBe(200);

    const cloudflareFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef') && method === 'GET') {
        return Response.json({
          success: true,
          result: {
            id: '0123456789abcdef0123456789abcdef',
            name: 'Test Account',
          },
        });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && method === 'GET') {
        return Response.json({
          success: true,
          result: {
            buckets: [
              { name: 'blog-data' },
            ],
          },
        });
      }

      if (url.endsWith('/user/tokens/permission_groups') && method === 'GET') {
        return Response.json({
          success: true,
          result: [
            { id: 'r2-read-group', name: 'Workers R2 Storage Bucket Item Read' },
            { id: 'r2-write-group', name: 'Workers R2 Storage Bucket Item Write' },
          ],
        });
      }

      if (url.endsWith('/user/tokens') && method === 'POST') {
        return Response.json({
          success: true,
          result: {
            id: 'created-r2-access-key',
            value: 'created-r2-token-value',
          },
        });
      }

      if (url.endsWith('/user/tokens/created-r2-access-key') && method === 'DELETE') {
        return Response.json({
          success: true,
          result: {},
        });
      }

      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', cloudflareFetch);

    const response = await bootstrapR2(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          bootstrap: {
            authEmail: 'owner@example.com',
            globalApiKey: 'global-key-should-not-leak',
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            snapshotOnWrite: false,
          },
          revision: 'stale-revision',
        }),
      })
    );
    const payload = await response.json();
    const storedSettings = JSON.parse(fs.readFileSync(getSettingsFile(process.env.BLOG_DATA_ROOT), 'utf8'));

    expect(response.status).toBe(409);
    expect(cloudflareFetch).toHaveBeenCalledTimes(5);
    expect(payload).toEqual(expect.objectContaining({
      message: 'Cloudflare R2 配置已被其他会话更新，请刷新后重试。',
      settings: {
        enabled: true,
        accountId: '22222222222222222222222222222222',
        bucket: 'server-bucket',
        hasAccessKeyId: true,
        hasSecretAccessKey: true,
        prefix: 'server-prefix',
        endpoint: '',
        snapshotOnWrite: true,
      },
      revision: createPayload.revision,
      status: expect.objectContaining({
        enabled: true,
        configured: true,
        bucket: 'server-bucket',
        prefix: 'server-prefix',
        endpoint: 'https://22222222222222222222222222222222.r2.cloudflarestorage.com',
        snapshotOnWrite: true,
        hasAccessKeyId: true,
        hasSecretAccessKey: true,
        source: 'file',
      }),
      backupQueue: {
        pending: 0,
        failed: 0,
        failedTasks: [],
      },
      backupQueueMessage: null,
    }));
    expect(storedSettings).toEqual(expect.objectContaining({
      bucket: 'server-bucket',
      accessKeyId: 'server-access-key',
      secretAccessKey: 'server-secret-key',
      prefix: 'server-prefix',
      snapshotOnWrite: true,
    }));
  });

  it('automatically configures R2 from a one-time Cloudflare global key without returning secrets', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const cloudflareFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef') && method === 'GET') {
        return Response.json({
          success: true,
          result: {
            id: '0123456789abcdef0123456789abcdef',
            name: 'Test Account',
          },
        });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && method === 'GET') {
        return Response.json({
          success: true,
          result: {
            buckets: [
              { name: 'blog-data' },
            ],
          },
        });
      }

      if (url.endsWith('/user/tokens/permission_groups') && method === 'GET') {
        return Response.json({
          success: true,
          result: [
            { id: 'r2-read-group', name: 'Workers R2 Storage Bucket Item Read' },
            { id: 'r2-write-group', name: 'Workers R2 Storage Bucket Item Write' },
          ],
        });
      }

      if (url.endsWith('/user/tokens') && method === 'POST') {
        const body = JSON.parse(String(init?.body));

        expect(body).toEqual(
          expect.objectContaining({
            policies: [
              expect.objectContaining({
                resources: {
                  'com.cloudflare.edge.r2.bucket.0123456789abcdef0123456789abcdef_default_blog-data': '*',
                },
                permission_groups: [
                  { id: 'r2-read-group' },
                  { id: 'r2-write-group' },
                ],
              }),
            ],
          })
        );

        return Response.json({
          success: true,
          result: {
            id: 'created-r2-access-key',
            value: 'created-r2-token-value',
          },
        });
      }

      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', cloudflareFetch);

    const response = await bootstrapR2(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          bootstrap: {
            authEmail: 'owner@example.com',
            globalApiKey: 'global-key-should-not-leak',
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            snapshotOnWrite: true,
          },
        }),
      })
    );
    const payload = await response.json();
    const settingsFile = getSettingsFile(process.env.BLOG_DATA_ROOT);
    const storedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const responseText = JSON.stringify(payload);
    const storedText = JSON.stringify(storedSettings);

    expect(response.status).toBe(200);
    expect(cloudflareFetch).toHaveBeenCalledTimes(4);
    expect(responseText).not.toContain('global-key-should-not-leak');
    expect(responseText).not.toContain('created-r2-token-value');
    expect(responseText).not.toContain(storedSettings.secretAccessKey);
    expect(storedText).not.toContain('global-key-should-not-leak');
    expect(storedText).not.toContain('created-r2-token-value');
    expect(storedSettings).toEqual(
      expect.objectContaining({
        enabled: true,
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'blog-data',
        accessKeyId: 'created-r2-access-key',
        secretAccessKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: true,
      })
    );
    expect(storedSettings).not.toHaveProperty('backupEncryptionKey');
    expect(storedSettings).not.toHaveProperty('allowPlaintextBackup');
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        bucketCreated: false,
        settings: expect.objectContaining({
          enabled: true,
          hasAccessKeyId: true,
          hasSecretAccessKey: true,
        }),
        status: expect.objectContaining({
          configured: true,
          securityWarning: expect.stringContaining('plaintext JSON'),
        }),
      })
    );
  });

  it('creates a missing R2 bucket during automatic configuration', async () => {
    clearR2Env();
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const cloudflareFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef') && method === 'GET') {
        return Response.json({ success: true, result: { id: '0123456789abcdef0123456789abcdef' } });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && method === 'GET') {
        return Response.json({ success: true, result: { buckets: [] } });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'new-blog-data' });
        return Response.json({ success: true, result: { name: 'new-blog-data' } });
      }

      if (url.endsWith('/user/tokens/permission_groups') && method === 'GET') {
        return Response.json({
          success: true,
          result: [
            { id: 'r2-read-group', name: 'Workers R2 Storage Bucket Item Read' },
            { id: 'r2-write-group', name: 'Workers R2 Storage Bucket Item Write' },
          ],
        });
      }

      if (url.endsWith('/user/tokens') && method === 'POST') {
        return Response.json({
          success: true,
          result: {
            id: 'created-r2-access-key',
            value: 'created-r2-token-value',
          },
        });
      }

      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', cloudflareFetch);

    const response = await bootstrapR2(
      await createAuthedEditorRequest('http://localhost/api/data/cloudflare-r2/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          bootstrap: {
            authEmail: 'owner@example.com',
            globalApiKey: 'global-key-should-not-leak',
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'new-blog-data',
            prefix: 'blog-navigation',
            snapshotOnWrite: false,
          },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.bucketCreated).toBe(true);
    expect(cloudflareFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/r2/buckets',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });
});
