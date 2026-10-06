import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { EDITOR_SESSION_COOKIE, EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER } from '@/lib/editor-auth';
import {
  createRuntimeEditorSession,
  resetEnvironmentEditorSessionForTests,
} from '@/lib/editor-auth-runtime';
import { resetAppRuntimeConfigCacheForTests } from '@/lib/app-runtime-config';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

describe('CSRF Protection', () => {
  const validCsrfToken = 'valid-csrf-token';
  const requestOrigin = 'http://localhost:3000';
  const ORIGINAL_ENV = {
    BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
    EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
    EDITOR_AUTH_CONFIG_FILE: process.env.EDITOR_AUTH_CONFIG_FILE,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  };
  const tempDirectories: string[] = [];
  let validSession = '';

  beforeEach(async () => {
    process.env.BLOG_DATA_ROOT = createTempDirectory('blog-navigation-csrf-protection-');
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    delete process.env.EDITOR_AUTH_CONFIG_FILE;
    delete process.env.COOKIE_SECURE;
    delete process.env.TRUSTED_PROXY_IPS;
    tempDirectories.push(process.env.BLOG_DATA_ROOT);
    resetEnvironmentEditorSessionForTests();
    resetAppRuntimeConfigCacheForTests();
    validSession = await createRuntimeEditorSession() ?? '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(ORIGINAL_ENV);
    resetEnvironmentEditorSessionForTests();
    resetAppRuntimeConfigCacheForTests();
    cleanupTempDirectories(tempDirectories);
  });

  function createMockRequest(options: {
    method?: string;
    origin?: string;
    sessionCookie?: string;
    csrfCookie?: string;
    csrfHeader?: string;
  }): NextRequest {
    const url = `${requestOrigin}/api/data/articles`;
    const headers = new Headers();

    if (options.origin) {
      headers.set('origin', options.origin);
    }

    if (options.csrfHeader) {
      headers.set(EDITOR_CSRF_HEADER, options.csrfHeader);
    }

    // Real Cookie header so NextRequest parses the cookies exactly like a
    // browser request instead of a hand-rolled cookies stub.
    const cookies: string[] = [];

    if (options.sessionCookie) {
      cookies.push(`${EDITOR_SESSION_COOKIE}=${options.sessionCookie}`);
    }

    if (options.csrfCookie) {
      cookies.push(`${EDITOR_CSRF_COOKIE}=${options.csrfCookie}`);
    }

    if (cookies.length > 0) {
      headers.set('cookie', cookies.join('; '));
    }

    return new NextRequest(url, {
      method: options.method || 'POST',
      headers,
    });
  }

  describe('ensureEditorWriteRequest', () => {
    it('should reject requests without CSRF token cookie', async () => {
      const request = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfHeader: validCsrfToken,
        // csrfCookie 缺失
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('should reject requests without CSRF token header', async () => {
      const request = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfCookie: validCsrfToken,
        // csrfHeader 缺失
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('should reject requests with mismatched CSRF tokens', async () => {
      const request = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfCookie: 'token-in-cookie',
        csrfHeader: 'different-token-in-header',
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('should reject requests from different origin', async () => {
      const request = createMockRequest({
        origin: 'https://evil.com',
        sessionCookie: validSession,
        csrfCookie: validCsrfToken,
        csrfHeader: validCsrfToken,
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('should reject requests without origin header', async () => {
      const request = createMockRequest({
        // origin 缺失
        sessionCookie: validSession,
        csrfCookie: validCsrfToken,
        csrfHeader: validCsrfToken,
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
    });

    it('accepts a real session cookie with a matching CSRF cookie and header from the same origin', async () => {
      const csrfToken = randomBytes(32).toString('hex');
      const request = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfCookie: csrfToken,
        csrfHeader: csrfToken,
      });

      await expect(ensureEditorWriteRequest(request)).resolves.toBeNull();
    });

    it('rejects the same check when the session cookie is not the active session', async () => {
      const csrfToken = randomBytes(32).toString('hex');
      const request = createMockRequest({
        origin: requestOrigin,
        sessionCookie: 'stale-session-value',
        csrfCookie: csrfToken,
        csrfHeader: csrfToken,
      });

      const response = await ensureEditorWriteRequest(request);

      expect(response?.status).toBe(401);
    });
  });

  describe('Timing-safe comparison', () => {
    it('should use constant-time comparison to prevent timing attacks', async () => {
      // 测试不同长度的 token
      const request1 = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfCookie: 'short',
        csrfHeader: 'very-long-token',
      });

      const response1 = await ensureEditorWriteRequest(request1);
      expect(response1).not.toBeNull();
      expect(response1?.status).toBe(403);

      // 测试相同长度但不同内容
      const request2 = createMockRequest({
        origin: requestOrigin,
        sessionCookie: validSession,
        csrfCookie: 'aaaaaaaaaa',
        csrfHeader: 'bbbbbbbbbb',
      });

      const response2 = await ensureEditorWriteRequest(request2);
      expect(response2).not.toBeNull();
      expect(response2?.status).toBe(403);
    });
  });
});
