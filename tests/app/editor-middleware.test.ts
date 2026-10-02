import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, middleware } from '@/middleware';
import { EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';

const ORIGINAL_ENV = {
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
};

let tempDataRoot: string | null = null;

function restoreEnv(): void {
  if (ORIGINAL_ENV.TRUSTED_PROXY_IPS === undefined) {
    delete process.env.TRUSTED_PROXY_IPS;
  } else {
    process.env.TRUSTED_PROXY_IPS = ORIGINAL_ENV.TRUSTED_PROXY_IPS;
  }

  if (ORIGINAL_ENV.BLOG_DATA_ROOT === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = ORIGINAL_ENV.BLOG_DATA_ROOT;
  }
}

function createEditorRequest(path: string, session?: string, headersInit?: HeadersInit): NextRequest {
  const headers = new Headers(headersInit);

  if (session) {
    headers.set('Cookie', `${EDITOR_SESSION_COOKIE}=${session}`);
  }

  return new NextRequest(`http://localhost${path}`, {
    headers,
  });
}

beforeEach(() => {
  // Point the data root at a fresh temp directory so the middleware reads no
  // stored app-runtime.json (falls back to TRUSTED_PROXY_IPS env) instead of
  // the repository's local data/settings/app-runtime.json.
  tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-nav-middleware-'));
  process.env.BLOG_DATA_ROOT = tempDataRoot;
});

afterEach(() => {
  restoreEnv();

  if (tempDataRoot) {
    fs.rmSync(tempDataRoot, { recursive: true, force: true });
    tempDataRoot = null;
  }

  vi.unstubAllGlobals();
});

describe('editor middleware', () => {
  it('applies to document routes while excluding API and static assets', () => {
    expect(config.matcher).toEqual([expect.stringContaining('api')]);
  });

  it('allows the editor login page without a session', () => {
    const response = middleware(createEditorRequest('/editor/login'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
  });

  it('redirects unauthenticated editor requests to login with a safe next path', () => {
    const response = middleware(createEditorRequest('/editor/settings?tab=r2'));
    const location = response.headers.get('location');

    expect(response.status).toBe(307);
    expect(location).toBe('http://localhost/editor/login?next=%2Feditor%2Fsettings%3Ftab%3Dr2');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
  });

  it('redirects unauthenticated editor requests to the public host header', () => {
    const response = middleware(createEditorRequest(
      '/editor/settings?tab=r2',
      undefined,
      { Host: 'public.example.com' }
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://public.example.com/editor/login?next=%2Feditor%2Fsettings%3Ftab%3Dr2'
    );
  });

  it('redirects unauthenticated editor requests to trusted forwarded host and proto', () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.1';

    const response = middleware(createEditorRequest(
      '/editor/settings?tab=r2',
      undefined,
      {
        Host: 'localhost:3000',
        'X-Forwarded-Host': 'public.example.com',
        'X-Forwarded-Proto': 'https',
      }
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://public.example.com/editor/login?next=%2Feditor%2Fsettings%3Ftab%3Dr2'
    );
  });

  it('allows editor requests with a session cookie without internal HTTP calls', () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    const response = middleware(createEditorRequest('/editor/navigation', 'opaque-session'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
  });

  it('redirects editor requests with an empty session cookie to login', () => {
    const response = middleware(createEditorRequest('/editor/blog', ''));

    expect(response.status).toBe(307);
    const location = response.headers.get('location');

    expect(location).toContain('/editor/login');
  });

  it('allows editor requests with any non-empty session cookie (validation deferred to API routes)', () => {
    const response = middleware(createEditorRequest('/editor/blog', 'tampered-value'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('uses nonce CSP for management document routes', () => {
    const response = middleware(createEditorRequest('/editor/blog', 'opaque-session'));
    const csp = response.headers.get('Content-Security-Policy');

    expect(response.status).toBe(200);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain('https://static.cloudflareinsights.com');
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('serves the reader pages anonymously on the same origin as the editor', () => {
    const anonymous = middleware(createEditorRequest('/blog'));
    const signedIn = middleware(createEditorRequest('/blog', 'opaque-session'));

    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('location')).toBeNull();
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('location')).toBeNull();
  });

  it('still protects editor documents behind the session', () => {
    const response = middleware(createEditorRequest('/editor/blog'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/editor/login');
  });

  it('keeps setup on nonce CSP because it is a configuration page', () => {
    const response = middleware(createEditorRequest('/setup'));
    const csp = response.headers.get('Content-Security-Policy');

    expect(response.status).toBe(200);
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
