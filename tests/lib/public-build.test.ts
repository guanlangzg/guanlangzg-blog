import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    getInlineScriptHashes,
    getPreviewNavigationHref,
    getStaticAssetUrl,
    validatePublicSiteSnapshot,
} from '@/lib/public-build/runner';

const snapshot = {
    releaseId: 'g01-release-01',
    site: { title: '观澜志', description: '静态构建验证' },
    posts: [{
        slug: '中文单段文章',
        title: '中文单段文章',
        description: '用于静态构建的冻结文章',
        date: '2026-09-30',
        tags: ['G01'],
        content: '冻结正文',
        managedImage: { source: 'media/article.png', alt: '受管图片' },
    }],
    navigation: [{
        name: '开发工具',
        items: [{ title: '示例入口', description: '导航搜索字段', url: 'https://example.com', tags: ['示例'] }],
    }],
};

describe('public build snapshot boundary', () => {
    it('accepts a Chinese one-segment slug and preserves its public data', () => {
        expect(validatePublicSiteSnapshot(snapshot)).toEqual(snapshot);
    });

    it.each(['nested/post', 'nested\\post', 'bad%2fpost', 'bad%5Cpost', 'bad%252fpost'])('rejects path separators in slug %s', (slug) => {
        expect(() => validatePublicSiteSnapshot({
            ...snapshot,
            posts: [{ ...snapshot.posts[0], slug }],
        })).toThrow(/slug/i);
    });

    it('accepts additive redirect and removed-path arrays under schema version 1', () => {
        expect(validatePublicSiteSnapshot({
            ...snapshot,
            redirects: [{ from: '/posts/old/', to: '/posts/new/' }],
            removedPaths: ['/blog/old/'],
        })).toMatchObject({
            redirects: [{ from: '/posts/old/', to: '/posts/new/' }],
            removedPaths: ['/blog/old/'],
        });
    });

    it('rejects redirect loops and fields outside the frozen public snapshot schema', () => {
        expect(() => validatePublicSiteSnapshot({ ...snapshot, draft: 'must not export' })).toThrow(/unknown/i);
        expect(() => validatePublicSiteSnapshot({ ...snapshot, redirects: [{ from: '/posts/a/', to: '/posts/a/' }] })).toThrow(/redirect/i);
    });

    it('places managed media under the release-specific asset path', () => {
        expect(getStaticAssetUrl('g01-release-01', 'media/abc.png'))
            .toBe('/_site/g01-release-01/media/abc.png');
    });

    it('hashes executable inline scripts from the sealed HTML bytes', () => {
        const html = '<script>window.g01 = "sealed";</script><script src="/_site/g01/_next/static/app.js"></script>';
        const expected = createHash('sha256').update('window.g01 = "sealed";').digest('base64');

        expect(getInlineScriptHashes(html)).toEqual([`sha256-${expected}`]);
    });
});

describe('version-bound preview navigation', () => {
    it('adds the fixed release ID only to an active preview navigation', () => {
        expect(getPreviewNavigationHref('/posts/中文单段文章/', {
            releaseId: 'g01-release-01',
            currentUrl: 'https://blog.example/posts/start/?previewRelease=g01-release-01',
        })).toBe('/posts/%E4%B8%AD%E6%96%87%E5%8D%95%E6%AE%B5%E6%96%87%E7%AB%A0/?previewRelease=g01-release-01');
    });

    it('blocks navigation from a stale preview tab', () => {
        expect(getPreviewNavigationHref('/navigation/', {
            releaseId: 'g01-release-02',
            currentUrl: 'https://blog.example/?previewRelease=g01-release-01',
        })).toBeNull();
    });

    it('leaves ordinary production navigation unmodified', () => {
        expect(getPreviewNavigationHref('/blog/', {
            releaseId: 'g01-release-01',
            currentUrl: 'https://blog.example/',
        })).toBe('/blog/');
    });
});
