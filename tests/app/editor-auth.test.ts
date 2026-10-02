import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/editor-auth/route';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import {
  EDITOR_CSRF_COOKIE,
  EDITOR_CSRF_HEADER,
  EDITOR_SESSION_COOKIE,
  SESSION_NAMESPACE,
  getSafeEditorNextPath,
} from '@/lib/editor-auth';
import { resetEditorAuthRateLimitForTests } from '@/lib/editor-auth-rate-limit';
import { resetEnvironmentEditorSessionForTests } from '@/lib/editor-auth-runtime';
import { getEditorAuditLogFilePath } from '@/lib/editor-audit-log';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_AUTH_CONFIG_FILE: process.env.EDITOR_AUTH_CONFIG_FILE,
  EDITOR_ALLOW_RUNTIME_AUTH_SETUP: process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP,
  EDITOR_RUNTIME_AUTH_SETUP_TOKEN: process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  COOKIE_SECURE: process.env.COOKIE_SECURE,
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  SKIP_IP_VALIDATION: process.env.SKIP_IP_VALIDATION,
};
const ORIGINAL_CWD = process.cwd();
const TEMP_DIRECTORIES: string[] = [];

async function createLegacyEditorSessionValue(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${SESSION_NAMESPACE}:${secret.trim()}`)
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function resetEnv(): void {
  restoreEnv(ORIGINAL_ENV);
}

function createTempDirectoryWithCleanup(prefix: string): string {
  const directory = createTempDirectory(prefix);

  TEMP_DIRECTORIES.push(directory);
  return directory;
}

function useCorruptRuntimeAuthConfig(prefix: string): string {
  delete process.env.EDITOR_ACCESS_TOKEN;
  const directory = createTempDirectoryWithCleanup(prefix);
  const configFilePath = path.join(directory, 'editor-auth.json');

  fs.writeFileSync(configFilePath, '{', 'utf8');
  process.env.EDITOR_AUTH_CONFIG_FILE = configFilePath;

  return configFilePath;
}

function createJsonRequest(body: unknown, headersInit?: HeadersInit): NextRequest {
  const headers = new Headers(headersInit);

  headers.set('Content-Type', 'application/json');

  return new NextRequest('http://localhost/api/editor-auth', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function extractSessionCookie(response: Response): string {
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

function extractCookie(response: Response, name: string): string {
  return response.headers.get('set-cookie')
    ?.split(',')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(';')[0] ?? '';
}

function createRequestWithSession(sessionCookie: string): NextRequest {
  return new NextRequest('http://localhost/api/data/articles', {
    headers: {
      Cookie: sessionCookie,
    },
  });
}

function createLogoutRequest(response: Response, headersInit?: HeadersInit): NextRequest {
  const sessionCookie = extractCookie(response, EDITOR_SESSION_COOKIE);
  const csrfCookie = extractCookie(response, EDITOR_CSRF_COOKIE);
  const headers = new Headers(headersInit);

  headers.set('Cookie', `${sessionCookie}; ${csrfCookie}`);
  headers.set('Origin', headers.get('Origin') ?? 'http://localhost');
  headers.set(EDITOR_CSRF_HEADER, csrfCookie.slice(`${EDITOR_CSRF_COOKIE}=`.length));

  return new NextRequest('http://localhost/api/editor-auth', {
    method: 'DELETE',
    headers,
  });
}

beforeEach(() => {
  process.chdir(createTempDirectoryWithCleanup('editor-auth-cwd-'));
});

afterEach(() => {
  resetEnv();
  process.chdir(ORIGINAL_CWD);
  resetEditorAuthRateLimitForTests();
  resetEnvironmentEditorSessionForTests();
  cleanupTempDirectories(TEMP_DIRECTORIES);
});

describe('editor auth API', () => {
  it('rejects login when the editor token is not initialized', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-empty-'),
      'editor-auth.json'
    );

    const response = await POST(createJsonRequest({ secret: 'anything' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('未初始化编辑口令'),
      })
    );
  });

  it('initializes the editor token once from the login page and stores no plaintext secret', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    const directory = createTempDirectoryWithCleanup('editor-auth-setup-');
    const configFilePath = path.join(directory, 'editor-auth.json');

    process.env.EDITOR_AUTH_CONFIG_FILE = configFilePath;
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';

    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'setup-token',
    }));
    const setupCookie = setupResponse.headers.get('set-cookie');
    const configText = fs.readFileSync(configFilePath, 'utf8');
    const setupSession = setupCookie?.match(new RegExp(`${EDITOR_SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';

    expect(setupResponse.status).toBe(200);
    expect(await setupResponse.json()).toEqual({ success: true });
    expect(setupCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(configText).not.toContain('new-secret-12chars');
    expect(configText).not.toContain(setupSession);

    const sessionResponse = await GET(
      new NextRequest('http://localhost/api/editor-auth', {
        headers: {
          Cookie: setupCookie?.split(';')[0] ?? '',
        },
      })
    );

    expect(await sessionResponse.json()).toEqual({
      configured: true,
      authenticated: true,
      setupEnabled: false,
      setupTokenRequired: false,
    });

    const loginResponse = await POST(createJsonRequest({ secret: 'new-secret-12chars' }));
    const loginCookie = loginResponse.headers.get('set-cookie') ?? '';

    expect(loginResponse.status).toBe(200);
    expect(loginCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(fs.readFileSync(configFilePath, 'utf8')).not.toContain(
      loginCookie.match(new RegExp(`${EDITOR_SESSION_COOKIE}=([^;]+)`))?.[1] ?? ''
    );

    const staleSetupSessionResponse = await GET(
      new NextRequest('http://localhost/api/editor-auth', {
        headers: {
          Cookie: setupCookie?.split(';')[0] ?? '',
        },
      })
    );
    const loginSessionResponse = await GET(
      new NextRequest('http://localhost/api/editor-auth', {
        headers: {
          Cookie: loginCookie.split(';')[0],
        },
      })
    );

    expect(await staleSetupSessionResponse.json()).toEqual(
      expect.objectContaining({
        configured: true,
        authenticated: false,
      })
    );
    expect(await loginSessionResponse.json()).toEqual(
      expect.objectContaining({
        configured: true,
        authenticated: true,
      })
    );
  });

  it('allows first-use initialization directly from the web when no editor auth exists', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    const configFilePath = path.join(
      createTempDirectoryWithCleanup('editor-auth-web-setup-'),
      'editor-auth.json'
    );

    process.env.EDITOR_AUTH_CONFIG_FILE = configFilePath;

    const statusBeforeSetup = await GET(new NextRequest('http://localhost/api/editor-auth'));

    expect(await statusBeforeSetup.json()).toEqual({
      configured: false,
      authenticated: false,
      setupEnabled: true,
      setupTokenRequired: false,
    });

    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
    }));

    expect(setupResponse.status).toBe(200);
    expect(await setupResponse.json()).toEqual({ success: true });
    expect(fs.readFileSync(configFilePath, 'utf8')).not.toContain('new-secret-12chars');

    const statusAfterSetup = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: {
        Cookie: extractSessionCookie(setupResponse),
      },
    }));

    expect(await statusAfterSetup.json()).toEqual({
      configured: true,
      authenticated: true,
      setupEnabled: false,
      setupTokenRequired: false,
    });
  });

  it('rejects first-use initialization in production without a setup token', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    delete process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN;
    delete process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP;
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SKIP_IP_VALIDATION = 'true';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-production-setup-'),
      'editor-auth.json'
    );

    const statusBeforeSetup = await GET(new NextRequest('http://localhost/api/editor-auth'));
    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
    }));

    expect(await statusBeforeSetup.json()).toEqual({
      configured: false,
      authenticated: false,
      setupEnabled: false,
      setupTokenRequired: false,
    });
    expect(setupResponse.status).toBe(403);
    expect(await setupResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('首次初始化未启用'),
      })
    );
  });

  it('ignores production runtime setup opt-in without a setup token', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    delete process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN;
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP = 'true';
    process.env.SKIP_IP_VALIDATION = 'true';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-production-missing-setup-token-'),
      'editor-auth.json'
    );

    const statusResponse = await GET(new NextRequest('http://localhost/api/editor-auth'));
    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
    }));

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      configured: false,
      authenticated: false,
      setupEnabled: false,
      setupTokenRequired: false,
    });
    expect(setupResponse.status).toBe(403);
    expect(await setupResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('首次初始化未启用'),
      })
    );
  });

  it('requires the configured setup token for production first-use initialization', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.SKIP_IP_VALIDATION = 'true';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-production-setup-token-'),
      'editor-auth.json'
    );

    const statusResponse = await GET(new NextRequest('http://localhost/api/editor-auth'));

    expect(await statusResponse.json()).toEqual({
      configured: false,
      authenticated: false,
      setupEnabled: true,
      setupTokenRequired: true,
    });

    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'setup-token',
    }));

    expect(setupResponse.status).toBe(200);
    expect(await setupResponse.json()).toEqual({ success: true });
  });

  it('rejects first-use initialization when the setup token is wrong', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-wrong-token-'),
      'editor-auth.json'
    );

    const response = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'wrong-token',
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('初始化密钥错误'),
      })
    );
  });

  it('does not allow first-use initialization to overwrite an existing token', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-existing-'),
      'editor-auth.json'
    );

    const response = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'setup-token',
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('已初始化'),
      })
    );
  });

  it('rejects malformed and wrong login secrets without setting a session cookie', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';

    const malformedResponse = await POST(
      new NextRequest('http://localhost/api/editor-auth', {
        method: 'POST',
        body: '{',
      })
    );
    const wrongSecretResponse = await POST(createJsonRequest({ secret: 'wrong-secret' }));

    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual(
      expect.objectContaining({
        code: 'invalid_json',
      })
    );
    expect(malformedResponse.headers.get('set-cookie')).toBeNull();
    expect(wrongSecretResponse.status).toBe(401);
    expect(wrongSecretResponse.headers.get('set-cookie')).toBeNull();
  });

  it('sets an http-only editor session cookie for a valid login', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';

    const response = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const setCookie = response.headers.get('set-cookie');
    const legacySession = await createLegacyEditorSessionValue('correct-secret');
    const auditEvents = fs.readFileSync(getEditorAuditLogFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string; outcome: string });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(setCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).toContain('Max-Age=28800');
    expect(setCookie).not.toContain(legacySession);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: 'auth.login.success',
        outcome: 'success',
      })
    );
  });

  it('honors COOKIE_SECURE=false for production HTTP deployments', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.COOKIE_SECURE = 'false';
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';

    const response = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.10' }
    ));
    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(response.status).toBe(200);
    expect(setCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(setCookie).toContain(`${EDITOR_CSRF_COOKIE}=`);
    expect(setCookie).not.toContain('Secure');
  });

  it('rotates environment-token sessions and rejects legacy deterministic sessions', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    const legacySession = await createLegacyEditorSessionValue('correct-secret');

    const firstLogin = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const firstCookie = extractSessionCookie(firstLogin);
    const secondLogin = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const secondCookie = extractSessionCookie(secondLogin);

    expect(firstLogin.status).toBe(200);
    expect(secondLogin.status).toBe(200);
    expect(firstCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(secondCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(secondCookie).not.toBe(firstCookie);

    const staleResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: firstCookie },
    }));
    const currentResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: secondCookie },
    }));
    const legacyResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: `${EDITOR_SESSION_COOKIE}=${legacySession}` },
    }));

    expect(await staleResponse.json()).toEqual(expect.objectContaining({ authenticated: false }));
    expect(await currentResponse.json()).toEqual(expect.objectContaining({ authenticated: true }));
    expect(await legacyResponse.json()).toEqual(expect.objectContaining({ authenticated: false }));
  });

  it('persists environment-token sessions under BLOG_DATA_ROOT for shared deployments', async () => {
    const dataRoot = createTempDirectoryWithCleanup('editor-auth-env-session-');

    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.BLOG_DATA_ROOT = dataRoot;

    const loginResponse = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const sessionCookie = extractSessionCookie(loginResponse);
    resetEnvironmentEditorSessionForTests();

    const sessionResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: sessionCookie },
    }));

    expect(fs.existsSync(path.join(dataRoot, 'settings', 'editor-env-session.json'))).toBe(true);
    expect(await sessionResponse.json()).toEqual(expect.objectContaining({ authenticated: true }));
  });

  it('falls back to process-memory sessions when BLOG_DATA_ROOT is blocked by a file path', async () => {
    const dataRoot = createTempDirectoryWithCleanup('editor-auth-env-session-blocked-');
    const blockingFile = path.join(dataRoot, 'blocked.txt');
    const blockedRoot = path.join(blockingFile, 'runtime-data');

    fs.writeFileSync(blockingFile, 'blocked', 'utf8');
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.BLOG_DATA_ROOT = blockedRoot;

    const loginResponse = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const sessionCookie = extractSessionCookie(loginResponse);
    const sessionResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: sessionCookie },
    }));
    const logoutResponse = await DELETE(createLogoutRequest(loginResponse));

    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toEqual({ success: true });
    expect(fs.existsSync(path.join(blockedRoot, 'settings', 'editor-env-session.json'))).toBe(false);
    expect(await sessionResponse.json()).toEqual(expect.objectContaining({ authenticated: true }));
    expect(logoutResponse.status).toBe(200);
  });

  it('keeps environment-token sessions valid after module reloads without BLOG_DATA_ROOT', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    delete process.env.BLOG_DATA_ROOT;

    const {
      createRuntimeEditorSession,
      isValidRuntimeEditorSession,
    } = await import('@/lib/editor-auth-runtime');
    const session = await createRuntimeEditorSession();

    vi.resetModules();

    const reloadedRuntime = await import('@/lib/editor-auth-runtime');

    await expect(isValidRuntimeEditorSession(session)).resolves.toBe(true);
    await expect(reloadedRuntime.isValidRuntimeEditorSession(session)).resolves.toBe(true);
  });

  it('rate limits repeated login failures', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(createJsonRequest({ secret: 'wrong-secret' }));
      expect(response.status).toBe(401);
    }

    const blockedResponse = await POST(createJsonRequest({ secret: 'correct-secret' }));

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get('set-cookie')).toBeNull();
    expect(await blockedResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('尝试次数过多'),
      })
    );
  });

  it('requires trusted proxy configuration for login rate limiting in production', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.SKIP_IP_VALIDATION;
    vi.stubEnv('NODE_ENV', 'production');

    const response = await POST(createJsonRequest({ secret: 'correct-secret' }));

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('TRUSTED_PROXY_IPS'),
      })
    );
  });

  it('isolates login rate limiting by client IP', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(createJsonRequest(
        { secret: 'wrong-secret' },
        { 'X-Forwarded-For': '198.51.100.10, 203.0.113.1' }
      ));

      expect(response.status).toBe(401);
    }

    const blockedResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.10, 203.0.113.1' }
    ));
    const otherClientResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.200, 203.0.113.1' }
    ));

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get('set-cookie')).toBeNull();
    expect(otherClientResponse.status).toBe(200);
    expect(otherClientResponse.headers.get('set-cookie')).toContain(`${EDITOR_SESSION_COOKIE}=`);
  });

  it('isolates rate limiting for a single forwarded IP recorded by the trusted proxy', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(createJsonRequest(
        { secret: 'wrong-secret' },
        { 'X-Forwarded-For': '198.51.100.10' }
      ));

      expect(response.status).toBe(401);
    }

    const blockedResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.10' }
    ));
    const otherClientResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.200' }
    ));

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get('set-cookie')).toBeNull();
    expect(otherClientResponse.status).toBe(200);
    expect(otherClientResponse.headers.get('set-cookie')).toContain(`${EDITOR_SESSION_COOKIE}=`);
  });

  it('isolates login rate limiting with a single forwarded client IP only when proxy trust is wildcard', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';
    process.env.TRUSTED_PROXY_IPS = '*';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(createJsonRequest(
        { secret: 'wrong-secret' },
        { 'X-Forwarded-For': '198.51.100.10' }
      ));

      expect(response.status).toBe(401);
    }

    const blockedResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.10' }
    ));
    const otherClientResponse = await POST(createJsonRequest(
      { secret: 'correct-secret' },
      { 'X-Forwarded-For': '198.51.100.200' }
    ));

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get('set-cookie')).toBeNull();
    expect(otherClientResponse.status).toBe(200);
    expect(otherClientResponse.headers.get('set-cookie')).toContain(`${EDITOR_SESSION_COOKIE}=`);
  });

  it('rate limits repeated setup failures', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-auth-setup-rate-limit-'),
      'editor-auth.json'
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await PUT(createJsonRequest({
        secret: 'new-secret-12chars',
        confirmSecret: 'new-secret-12chars',
        setupToken: 'wrong-token',
      }));
      expect(response.status).toBe(403);
    }

    const blockedResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'setup-token',
    }));

    expect(blockedResponse.status).toBe(429);
    expect(blockedResponse.headers.get('set-cookie')).toBeNull();
  });

  it('clears the editor session cookie on logout', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';

    const loginResponse = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const response = await DELETE(createLogoutRequest(loginResponse));
    const setCookie = response.headers.get('set-cookie');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(setCookie).toContain(`${EDITOR_SESSION_COOKIE}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('requires an authenticated same-origin CSRF-protected request for logout', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'correct-secret';

    const loginResponse = await POST(createJsonRequest({ secret: 'correct-secret' }));
    const sessionCookie = extractCookie(loginResponse, EDITOR_SESSION_COOKIE);
    const csrfCookie = extractCookie(loginResponse, EDITOR_CSRF_COOKIE);
    const csrfToken = csrfCookie.slice(`${EDITOR_CSRF_COOKIE}=`.length);
    const missingSessionResponse = await DELETE(new NextRequest('http://localhost/api/editor-auth', {
      method: 'DELETE',
      headers: {
        Origin: 'http://localhost',
      },
    }));
    const missingCsrfResponse = await DELETE(new NextRequest('http://localhost/api/editor-auth', {
      method: 'DELETE',
      headers: {
        Cookie: `${sessionCookie}; ${csrfCookie}`,
        Origin: 'http://localhost',
      },
    }));
    const crossOriginResponse = await DELETE(new NextRequest('http://localhost/api/editor-auth', {
      method: 'DELETE',
      headers: {
        Cookie: `${sessionCookie}; ${csrfCookie}`,
        Origin: 'https://attacker.example',
        [EDITOR_CSRF_HEADER]: csrfToken,
      },
    }));

    expect(missingSessionResponse.status).toBe(401);
    expect(missingCsrfResponse.status).toBe(403);
    expect(crossOriginResponse.status).toBe(403);
  });

  it('revokes the current runtime editor session on logout', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    const configFilePath = path.join(
      createTempDirectoryWithCleanup('editor-auth-logout-'),
      'editor-auth.json'
    );

    process.env.EDITOR_AUTH_CONFIG_FILE = configFilePath;
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';

    const setupResponse = await PUT(createJsonRequest({
      secret: 'new-secret-12chars',
      confirmSecret: 'new-secret-12chars',
      setupToken: 'setup-token',
    }));
    const setupCookie = setupResponse.headers.get('set-cookie')?.split(';')[0] ?? '';

    expect((await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: setupCookie },
    }))).status).toBe(200);

    await DELETE(createLogoutRequest(setupResponse));

    const sessionResponse = await GET(new NextRequest('http://localhost/api/editor-auth', {
      headers: { Cookie: setupCookie },
    }));

    expect(await sessionResponse.json()).toEqual(
      expect.objectContaining({
        configured: true,
        authenticated: false,
      })
    );
  });

  it('fails fast when the runtime auth config file is corrupt', async () => {
    const configFilePath = useCorruptRuntimeAuthConfig('editor-auth-corrupt-api-');
    process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN = 'setup-token';

    const getResponse = await GET(new NextRequest('http://localhost/api/editor-auth'));
    const postResponse = await POST(createJsonRequest({ secret: 'new-secret-12chars' }));
    const putResponse = await PUT(createJsonRequest({
      secret: 'replacement-secret',
      confirmSecret: 'replacement-secret',
      setupToken: 'setup-token',
    }));
    const deleteResponse = await DELETE(new NextRequest('http://localhost/api/editor-auth', {
      method: 'DELETE',
    }));

    expect(getResponse.status).toBe(500);
    expect(postResponse.status).toBe(500);
    expect(postResponse.headers.get('set-cookie')).toBeNull();
    expect(putResponse.status).toBe(500);
    expect(putResponse.headers.get('set-cookie')).toBeNull();
    expect(deleteResponse.status).toBe(500);
    expect(deleteResponse.headers.get('set-cookie')).toBeNull();
    expect(fs.readFileSync(configFilePath, 'utf8')).toBe('{');
    expect(await getResponse.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('配置文件损坏'),
      })
    );
  });
});

describe('editor API session guard', () => {
  it('returns a service error when editor auth is not initialized', async () => {
    delete process.env.EDITOR_ACCESS_TOKEN;
    process.env.EDITOR_AUTH_CONFIG_FILE = path.join(
      createTempDirectoryWithCleanup('editor-api-auth-empty-'),
      'editor-auth.json'
    );

    const response = await ensureEditorSession(new NextRequest('http://localhost/api/data/articles'));

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('未初始化编辑口令'),
      })
    );
  });

  it('rejects missing or stale sessions and accepts the current session', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'current-secret';
    const loginResponse = await POST(createJsonRequest({ secret: 'current-secret' }));
    const currentSessionCookie = extractSessionCookie(loginResponse);
    const staleSession = await createLegacyEditorSessionValue('current-secret');

    const missingSessionResponse = await ensureEditorSession(
      new NextRequest('http://localhost/api/data/articles')
    );
    const staleSessionResponse = await ensureEditorSession(
      createRequestWithSession(`${EDITOR_SESSION_COOKIE}=${staleSession}`)
    );
    const currentSessionResponse = await ensureEditorSession(
      createRequestWithSession(currentSessionCookie)
    );

    expect(missingSessionResponse?.status).toBe(401);
    expect(staleSessionResponse?.status).toBe(401);
    expect(currentSessionResponse).toBeNull();
  });

  it('locks editor data APIs when the runtime auth config file is corrupt', async () => {
    useCorruptRuntimeAuthConfig('editor-api-auth-corrupt-');

    const response = await ensureEditorSession(new NextRequest('http://localhost/api/data/articles'));

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('配置文件损坏'),
      })
    );
  });
});

describe('safe editor next path', () => {
  it('keeps editor-local paths and rejects external destinations', () => {
    expect(getSafeEditorNextPath('/editor/settings?tab=r2')).toBe('/editor/settings?tab=r2');
    expect(getSafeEditorNextPath('/navigation')).toBe('/editor');
    expect(getSafeEditorNextPath('https://example.com/editor')).toBe('/editor');
    expect(getSafeEditorNextPath('//example.com/editor')).toBe('/editor');
  });
});
