import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { middleware } from '@/middleware';
import { EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';

const ORIGINAL_ENV = { BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT };
let tempDataRoot: string | null = null;

function createRequest(url: string, options: { session?: string; headers?: HeadersInit } = {}): NextRequest {
  const headers = new Headers(options.headers);

  if (options.session) {
    headers.set('Cookie', `${EDITOR_SESSION_COOKIE}=${options.session}`);
  }

  return new NextRequest(`http://localhost${url}`, { headers });
}

function rewriteTarget(response: Response): string | null {
  return response.headers.get('x-middleware-rewrite');
}

beforeEach(() => {
  tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-preview-routing-'));
  process.env.BLOG_DATA_ROOT = tempDataRoot;
});

afterEach(() => {
  if (ORIGINAL_ENV.BLOG_DATA_ROOT === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = ORIGINAL_ENV.BLOG_DATA_ROOT;
  }

  if (tempDataRoot) {
    fs.rmSync(tempDataRoot, { recursive: true, force: true });
    tempDataRoot = null;
  }
});

describe('VPS content boundary', () => {
  it('sends an anonymous reader page request to the login page', () => {
    const response = middleware(createRequest('/'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/editor/login?next=%2Feditor');
    expect(rewriteTarget(response)).toBeNull();
  });

  it('sends a signed-in admin to the management entry instead of the old dynamic page', () => {
    for (const pathname of ['/', '/blog', '/navigation', '/search', '/posts/%E4%B8%AD%E6%96%87']) {
      const response = middleware(createRequest(pathname, { session: 'opaque-session' }));

      expect(response.status, pathname).toBe(307);
      expect(response.headers.get('location'), pathname).toBe('http://localhost/editor');
    }
  });

  it('refuses anonymous public resources with 401 and no working-copy bytes', () => {
    for (const pathname of ['/feed.xml', '/sitemap.xml', '/robots.txt', '/og', '/media/files/2026/01/a.png']) {
      const response = middleware(createRequest(pathname));

      expect(response.status, pathname).toBe(401);
      expect(response.headers.get('cache-control'), pathname).toBe('private, no-store');
      expect(rewriteTarget(response), pathname).toBeNull();
    }
  });

  it('refuses prefetch and RSC navigation without a release instead of redirecting', () => {
    const prefetch = middleware(createRequest('/blog', { headers: { 'next-router-prefetch': '1' } }));
    const rsc = middleware(createRequest('/blog', { headers: { RSC: '1' } }));

    expect(prefetch.status).toBe(401);
    expect(rsc.status).toBe(401);
    expect(rewriteTarget(prefetch)).toBeNull();
    expect(rewriteTarget(rsc)).toBeNull();
  });

  it('still refuses prefetch requests that carry a session but no release id', () => {
    const response = middleware(createRequest('/blog', {
      session: 'opaque-session',
      headers: { purpose: 'prefetch', 'next-router-prefetch': '1' },
    }));

    expect(response.status).toBe(404);
    expect(rewriteTarget(response)).toBeNull();
  });

  it('rewrites a signed-in preview document request to the sealed artifact service', () => {
    const response = middleware(createRequest('/?previewRelease=rel-1', { session: 'opaque-session' }));

    expect(rewriteTarget(response)).toBe(
      'http://localhost/api/editor/preview-files/rel-1/index.html?previewRelease=rel-1'
    );
  });

  it('keeps encoded article paths and maps nested routes to their sealed index page', () => {
    const response = middleware(createRequest('/posts/%E4%B8%AD%E6%96%87/?previewRelease=rel-1', {
      session: 'opaque-session',
    }));

    expect(rewriteTarget(response)).toBe(
      'http://localhost/api/editor/preview-files/rel-1/posts/%E4%B8%AD%E6%96%87/index.html?previewRelease=rel-1'
    );
  });

  it('maps preview RSC navigation to the sealed payload of the same release', () => {
    const response = middleware(createRequest('/blog?previewRelease=rel-1', {
      session: 'opaque-session',
      headers: { RSC: '1' },
    }));

    expect(rewriteTarget(response)).toBe(
      'http://localhost/api/editor/preview-files/rel-1/blog/index.txt?previewRelease=rel-1'
    );
  });

  it('binds release assets by their own path id and does not guess from the cookie', () => {
    const response = middleware(createRequest('/_site/rel-1/_next/static/chunks/app.js', {
      session: 'opaque-session',
    }));

    expect(rewriteTarget(response)).toBe(
      'http://localhost/api/editor/preview-files/rel-1/_site/rel-1/_next/static/chunks/app.js?previewRelease=rel-1'
    );
  });

  it('refuses a release asset whose query release id disagrees with its path', () => {
    const response = middleware(createRequest('/_site/rel-1/preview.js?previewRelease=rel-2', {
      session: 'opaque-session',
    }));

    expect(response.status).toBe(404);
    expect(rewriteTarget(response)).toBeNull();
  });

  it('never rewrites a preview request for an anonymous caller', () => {
    const document = middleware(createRequest('/?previewRelease=rel-1'));
    const asset = middleware(createRequest('/_site/rel-1/preview.js'));

    expect(document.status).toBe(401);
    expect(asset.status).toBe(401);
    expect(rewriteTarget(document)).toBeNull();
    expect(rewriteTarget(asset)).toBeNull();
  });

  it('does not attach the management nonce CSP to sealed preview bytes', () => {
    const response = middleware(createRequest('/?previewRelease=rel-1', { session: 'opaque-session' }));

    expect(response.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('leaves the login page, setup and management assets reachable', () => {
    for (const pathname of ['/editor/login', '/setup', '/_next/static/chunks/main.js']) {
      const response = middleware(createRequest(pathname));

      expect(response.status, pathname).toBe(200);
      expect(response.headers.get('location'), pathname).toBeNull();
    }
  });

  it('keeps the matcher applied to prefetch requests', async () => {
    const { config } = await import('@/middleware');

    expect(config.matcher).toEqual([expect.stringContaining('api')]);
    expect(JSON.stringify(config.matcher)).not.toContain('prefetch');
  });
});
