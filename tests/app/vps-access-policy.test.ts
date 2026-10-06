import { describe, expect, it } from 'vitest';
import { classifyVpsRequest, PREVIEW_RELEASE_PARAM } from '@/lib/vps-access-policy';

function classify(pathname: string, options: { previewRelease?: string | null; rsc?: boolean } = {}) {
  return classifyVpsRequest({
    pathname,
    previewRelease: options.previewRelease ?? null,
    isRscRequest: options.rsc ?? false,
  });
}

describe('VPS access policy', () => {
  it('exposes the preview release parameter name used by every entry point', () => {
    expect(PREVIEW_RELEASE_PARAM).toBe('previewRelease');
  });

  it('allows the login page, setup, management assets and brand files anonymously', () => {
    for (const pathname of [
      '/editor/login',
      '/setup',
      '/_next/static/chunks/main.js',
      '/favicon.ico',
      '/guanlan-logo.png',
      '/favicon-32.png',
    ]) {
      expect(classify(pathname), pathname).toEqual({ kind: 'allow' });
    }
  });

  it('keeps editor documents on the editor session branch', () => {
    expect(classify('/editor')).toEqual({ kind: 'editor' });
    expect(classify('/editor/blog')).toEqual({ kind: 'editor' });
  });

  it('leaves API routes to their own authentication', () => {
    expect(classify('/api/search')).toEqual({ kind: 'allow' });
    expect(classify('/api/editor/releases')).toEqual({ kind: 'allow' });
  });

  it('serves the reader pages anonymously on the VPS', () => {
    for (const pathname of ['/', '/blog', '/blog/', '/posts/%E4%B8%AD%E6%96%87', '/navigation', '/navigation/']) {
      expect(classify(pathname), pathname).toEqual({ kind: 'allow' });
    }
  });

  it('keeps unrendered public documents behind the login page', () => {
    expect(classify('/search')).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/manifest.webmanifest')).toEqual({ kind: 'blocked', target: 'resource' });
  });

  it('serves public feeds, sitemap, robots and OG images anonymously', () => {
    for (const pathname of ['/feed.xml', '/sitemap.xml', '/robots.txt', '/og']) {
      expect(classify(pathname), pathname).toEqual({ kind: 'allow' });
    }
  });

  it('allows only validated public media URLs and keeps other unlisted resources blocked', () => {
    expect(classify(`/media/files/2026/01/${'a'.repeat(64)}.png`)).toEqual({ kind: 'allow' });
    for (const pathname of ['/media/files/2026/01/not-a-digest.png', '/llms.txt', '/search-index.json']) {
      expect(classify(pathname), pathname).toEqual({ kind: 'blocked', target: 'resource' });
    }
  });

  it('binds a preview media request to the sealed media of the named release', () => {
    const mediaPath = `/media/files/2026/01/${'a'.repeat(64)}.png`;

    expect(classify(mediaPath, { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: `_site/rel-1/media/files/2026/01/${'a'.repeat(64)}.png`,
    });
  });

  it('refuses a preview media request whose release id is malformed', () => {
    const mediaPath = `/media/files/2026/01/${'a'.repeat(64)}.png`;

    expect(classify(mediaPath, { previewRelease: '../secret' })).toEqual({
      kind: 'blocked',
      target: 'resource',
    });
  });

  it('serves RSC and prefetch reader requests anonymously so client navigation works', () => {
    expect(classify('/blog', { rsc: true })).toEqual({ kind: 'allow' });
  });

  it('maps a preview document request to the sealed index page of that release', () => {
    expect(classify('/', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'index.html',
    });
    expect(classify('/blog/', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'blog/index.html',
    });
    expect(classify('/posts/%E4%B8%AD%E6%96%87', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'posts/%E4%B8%AD%E6%96%87/index.html',
    });
  });

  it('maps preview RSC requests to the sealed .txt payload instead of the HTML page', () => {
    expect(classify('/blog', { previewRelease: 'rel-1', rsc: true })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'blog/index.txt',
    });
  });

  it('maps preview file requests with an extension straight to the sealed file', () => {
    expect(classify('/feed.xml', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'feed.xml',
    });
    expect(classify('/search-index.json', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: 'search-index.json',
    });
  });

  it('derives the release id from the artifact path for release-bound assets', () => {
    expect(classify('/_site/rel-1/_next/static/chunks/app.js')).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: '_site/rel-1/_next/static/chunks/app.js',
    });
    expect(classify('/_site/rel-1/preview.js', { previewRelease: 'rel-1' })).toEqual({
      kind: 'preview',
      releaseId: 'rel-1',
      artifactPath: '_site/rel-1/preview.js',
    });
  });

  it('refuses a release-bound asset whose query release id disagrees with its path', () => {
    expect(classify('/_site/rel-1/preview.js', { previewRelease: 'rel-2' })).toEqual({
      kind: 'blocked',
      target: 'resource',
    });
  });

  it('refuses malformed release ids and traversal attempts', () => {
    expect(classify('/', { previewRelease: '../secret' })).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/_site/..%2fsecret/app.js')).toEqual({ kind: 'blocked', target: 'resource' });
    expect(classify('/posts/a%2fb', { previewRelease: 'rel-1' })).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/_site/rel-1/../../etc/passwd')).toEqual({ kind: 'blocked', target: 'resource' });
  });
});
