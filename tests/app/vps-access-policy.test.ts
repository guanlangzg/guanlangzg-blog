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

  it('blocks public documents that carry no preview release', () => {
    expect(classify('/')).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/blog')).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/posts/%E4%B8%AD%E6%96%87')).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/navigation/')).toEqual({ kind: 'blocked', target: 'document' });
    expect(classify('/search')).toEqual({ kind: 'blocked', target: 'document' });
  });

  it('blocks public resources, legacy media and OG images as resources', () => {
    for (const pathname of ['/feed.xml', '/sitemap.xml', '/robots.txt', '/og', '/media/files/2026/01/abc.png']) {
      expect(classify(pathname), pathname).toEqual({ kind: 'blocked', target: 'resource' });
    }
  });

  it('treats RSC and prefetch document requests as resources so they never redirect', () => {
    expect(classify('/blog', { rsc: true })).toEqual({ kind: 'blocked', target: 'resource' });
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
