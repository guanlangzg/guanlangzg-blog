import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUT, GET } from '@/app/api/setup/route';
import { resetAppRuntimeConfigCacheForTests } from '@/lib/app-runtime-config';
import * as editorAuthRuntime from '@/lib/editor-auth-runtime';
import {
  resetEnvironmentEditorSessionForTests,
} from '@/lib/editor-auth-runtime';
import { resetEditorAuthRateLimitForTests } from '@/lib/editor-auth-rate-limit';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  EDITOR_AUTH_CONFIG_FILE: process.env.EDITOR_AUTH_CONFIG_FILE,
  EDITOR_RUNTIME_AUTH_SETUP_TOKEN: process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN,
  EDITOR_ALLOW_RUNTIME_AUTH_SETUP: process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP,
  NODE_ENV: process.env.NODE_ENV,
  COOKIE_SECURE: process.env.COOKIE_SECURE,
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-setup-route-');

  tempDirectories.push(directory);
  process.env.BLOG_DATA_ROOT = directory;
  return directory;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  process.env.BLOG_DATA_ROOT = path.join(blockingFile, 'runtime-data');
  return process.env.BLOG_DATA_ROOT;
}

function clearRuntimeEnv(): void {
  Object.keys(ORIGINAL_ENV).forEach((name) => {
    delete process.env[name];
  });
}

// clearRuntimeEnv() unsets NODE_ENV, which security gates treat as production.
// First-run setup tests must therefore opt in the same way a bare `node
// server.js` operator would, and pin a client id the rate limiter can trust.
function allowUnauthenticatedFirstSetup(): void {
  process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP = 'true';
  process.env.TRUSTED_PROXY_IPS = '*';
}

function createSetupRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/setup', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createBaseSetupBody(dataRoot: string) {
  return {
    config: {
      publicSiteUrl: 'https://example.com',
      cookieSecure: false,
      trustedProxyIps: '',
      dataRootPath: dataRoot,
    },
    editorSecret: 'new-runtime-secret-12',
    confirmEditorSecret: 'new-runtime-secret-12',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreEnv(ORIGINAL_ENV);
  resetAppRuntimeConfigCacheForTests();
  resetEnvironmentEditorSessionForTests();
  resetEditorAuthRateLimitForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('setup API R2 flow', () => {
  it('rejects first setup in production when runtime auth setup is not enabled', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('首次初始化未启用'),
      })
    );
  });

  it('rejects first setup in production when setup opt-in is enabled without a setup token', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP = 'true';

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('首次初始化未启用'),
      })
    );
  });

  it('rejects a forbidden weak password during first setup before saving configuration', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.TRUSTED_PROXY_IPS = '*';

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      editorSecret: '123456789012',
      confirmEditorSecret: '123456789012',
      setupToken: 'setup-token',
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '编辑口令不符合安全要求。' });
    expect(fs.existsSync(path.join(dataRoot, 'settings', 'editor-auth.json'))).toBe(false);
  });

  it('allows first setup in production when a setup token is configured', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.TRUSTED_PROXY_IPS = '*';

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      setupToken: 'setup-token',
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ success: true }));
  });

  it('rate limits repeated setup token failures', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.TRUSTED_PROXY_IPS = '*';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await PUT(createSetupRequest({
        ...createBaseSetupBody(dataRoot),
        setupToken: 'wrong-token',
        r2SetupMode: 'disabled',
        r2Settings: {
          enabled: false,
          accountId: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: '',
          prefix: 'blog-navigation',
          endpoint: '',
          snapshotOnWrite: false,
        },
      }));

      expect(response.status).toBe(403);
    }

    const blockedResponse = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      setupToken: 'setup-token',
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(blockedResponse.status).toBe(429);
    expect(await blockedResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('尝试次数过多'),
      })
    );
  });

  it('keeps the client identity configuration gate on first setup in production', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.SKIP_IP_VALIDATION;
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      setupToken: 'setup-token',
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('TRUSTED_PROXY_IPS'),
      })
    );
  });

  it('requires an authenticated editor session when auth is already configured before setup is complete', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    process.env.EDITOR_ACCESS_TOKEN = 'existing-editor-token';

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(401);
  });

  it('allows authenticated setup when auth is already configured before setup is complete', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    process.env.EDITOR_ACCESS_TOKEN = 'existing-editor-token';
    // Login goes through the auth rate limiter, which needs a reliable client id.
    process.env.TRUSTED_PROXY_IPS = '*';

    const body = {
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    };
    const request = await createAuthedEditorRequest('http://localhost/api/setup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await PUT(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ success: true }));
  });

  it('lets first setup explicitly skip R2 and saves disabled settings', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    allowUnauthenticatedFirstSetup();

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: true,
        accountId: 'stale-account-id',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));
    const payload = await response.json();
    const storedSettings = JSON.parse(
      fs.readFileSync(path.join(dataRoot, 'settings', 'cloudflare-r2.json'), 'utf8')
    );

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({ success: true }));
    expect(storedSettings).toEqual(
      expect.objectContaining({
        enabled: false,
        accessKeyId: '',
        secretAccessKey: '',
      })
    );
  });

  it('saves manual R2 setup without removed legacy secret fields', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    allowUnauthenticatedFirstSetup();

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'manual',
      r2Settings: {
        enabled: true,
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'blog-data',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: true,
      },
    }));
    const payload = await response.json();
    const storedText = fs.readFileSync(path.join(dataRoot, 'settings', 'cloudflare-r2.json'), 'utf8');
    const storedSettings = JSON.parse(storedText);

    expect(response.status).toBe(200);
    expect(JSON.stringify(payload)).not.toContain('secret-key');
    expect(storedSettings).toEqual(
      expect.objectContaining({
        enabled: true,
        secretAccessKey: 'secret-key',
        snapshotOnWrite: true,
      })
    );
    expect(storedSettings).not.toHaveProperty('backupEncryptionPassphrase');
    expect(storedSettings).not.toHaveProperty('backupEncryptionKey');
    expect(storedSettings).not.toHaveProperty('allowPlaintextBackup');
  });

  it('starts Cloudflare R2 setup without removed legacy secret fields', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    allowUnauthenticatedFirstSetup();
    const cloudflareFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef')) {
        return Response.json({ success: true, result: {} });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && init?.method === 'GET') {
        return Response.json({ success: true, result: { buckets: [] } });
      }

      if (url.endsWith('/accounts/0123456789abcdef0123456789abcdef/r2/buckets') && init?.method === 'POST') {
        return Response.json({ success: true, result: {} });
      }

      if (url.endsWith('/tokens/permission_groups')) {
        return Response.json({
          success: true,
          result: [
            { id: 'read-group', name: 'Workers R2 Storage Bucket Item Read' },
            { id: 'write-group', name: 'Workers R2 Storage Bucket Item Write' },
          ],
        });
      }

      if (url.endsWith('/r2/buckets/blog-data')) {
        return Response.json({ success: true, result: {} });
      }

      if (url.endsWith('/tokens') && init?.method === 'POST') {
        return Response.json({
          success: true,
          result: {
            id: 'token-id',
            name: 'blog-navigation-blog-data',
            value: 'created-token-secret',
          },
        });
      }

      return Response.json({ success: false, errors: [{ message: `Unexpected URL: ${url}` }] }, { status: 400 });
    });

    vi.stubGlobal('fetch', cloudflareFetch);

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'cloudflare',
      cloudflareR2Setup: {
        authEmail: 'owner@example.com',
        globalApiKey: 'global-key-should-not-leak',
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'blog-data',
        prefix: 'blog-navigation',
        snapshotOnWrite: false,
      },
    }));
    const payload = await response.json();
    const storedText = fs.readFileSync(path.join(dataRoot, 'settings', 'cloudflare-r2.json'), 'utf8');
    const storedSettings = JSON.parse(storedText);
    const expectedSecret = createHash('sha256').update('created-token-secret').digest('hex');

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({ success: true }));
    expect(cloudflareFetch).toHaveBeenCalled();
    expect(storedSettings).toEqual(
      expect.objectContaining({
        enabled: true,
        accessKeyId: 'token-id',
        secretAccessKey: expectedSecret,
      })
    );
    expect(storedSettings).not.toHaveProperty('backupEncryptionPassphrase');
    expect(storedSettings).not.toHaveProperty('backupEncryptionKey');
    expect(storedSettings).not.toHaveProperty('allowPlaintextBackup');
  });

  it('reports a blocked runtime data root with a structured 503 response during first setup', async () => {
    clearRuntimeEnv();
    const dataRoot = createBlockedDataRoot();
    allowUnauthenticatedFirstSetup();

    const response = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'runtime_data_root_unavailable',
      message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
    });
  });

  it('returns 409 for a concurrent second setup request after the first one completes', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    allowUnauthenticatedFirstSetup();
    const originalInitializeRuntimeEditorAuth = editorAuthRuntime.initializeRuntimeEditorAuth;
    let releaseInitialization: (() => void) | undefined;
    const initializationBlocked = new Promise<void>((resolve) => {
      releaseInitialization = () => resolve();
    });

    vi.spyOn(editorAuthRuntime, 'initializeRuntimeEditorAuth').mockImplementation(async (secret: string) => {
      await initializationBlocked;
      return originalInitializeRuntimeEditorAuth(secret);
    });

    const requestBody = {
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    };

    const firstResponsePromise = PUT(createSetupRequest(requestBody));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponsePromise = PUT(createSetupRequest(requestBody));

    releaseInitialization?.();

    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);
    const secondPayload = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    expect(secondPayload).toEqual({
      message: '首次启动引导已完成。',
    });
  });
});

describe('setup API GET', () => {
  it('returns full initialization info before setup is complete', async () => {
    clearRuntimeEnv();
    createTempDataRoot();

    const response = await GET(new NextRequest('http://localhost/api/setup'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        setupCompleted: false,
        authConfigured: expect.any(Boolean),
        setupEnabled: expect.any(Boolean),
        editable: expect.any(Object),
        r2Settings: expect.any(Object),
      })
    );
  });

  it('returns only setupCompleted after setup is complete', async () => {
    clearRuntimeEnv();
    const dataRoot = createTempDataRoot();
    allowUnauthenticatedFirstSetup();

    const setupResponse = await PUT(createSetupRequest({
      ...createBaseSetupBody(dataRoot),
      r2SetupMode: 'disabled',
      r2Settings: {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
      },
    }));

    expect(setupResponse.status).toBe(200);

    const response = await GET(new NextRequest('http://localhost/api/setup'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ setupCompleted: true });
    expect(payload).not.toHaveProperty('editable');
    expect(payload).not.toHaveProperty('r2Settings');
    expect(payload).not.toHaveProperty('r2Status');
    expect(payload).not.toHaveProperty('config');
    expect(payload).not.toHaveProperty('authConfigured');
  });
});
