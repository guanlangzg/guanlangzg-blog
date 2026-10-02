import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicSiteSnapshot } from '@/public-site/types';
import { servePreviewArtifact } from '@/lib/public-build/preview';
import { matchesPublicSearchDocument } from '@/public-site/search-index';

const workspaceRoot = process.cwd();
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'g01-public-artifacts-'));
const snapshotPath = path.join(temporaryRoot, 'frozen-candidate.json');
const artifactRoot = path.join(temporaryRoot, 'artifacts');
const releaseId = 'g01-integration-release';

const snapshot: PublicSiteSnapshot = {
    releaseId,
    site: { title: '观澜志 G01', description: '来自冻结快照的静态公开站' },
    posts: [{
        slug: '静态文章',
        title: '冻结文章标题',
        description: '这是用于 G01 静态导出验收的冻结内容。',
        date: '2026-09-30',
        tags: ['G01', '静态构建'],
        content: '# 冻结文章标题\n\n只从冻结候选生成。中文检索词来自正文。\n\n![受管图片](/media/article.png)',
        managedImage: { source: 'media/article.png', alt: '受管文章图片' },
    }, {
        slug: '无封面文章',
        title: '无封面的分享标题',
        description: '封面缺省时也生成分享图。',
        date: '2026-09-29',
        tags: ['分享'],
        content: '一篇没有封面的文章。',
    }],
    navigation: [{
        name: '开发工具',
        items: [{ title: '冻结导航项', description: '用于搜索的导航描述', url: 'https://example.com/tools', tags: ['工具'] }],
    }],
    redirects: [{ from: '/posts/旧文章/', to: '/posts/静态文章/?x=1&y="> <script>alert(1)</script>' }],
    removedPaths: ['/blog/legacy-post/'],
};

function runBuild(args = ['--snapshot', snapshotPath, '--out', artifactRoot]) {
    return spawnSync(process.execPath, [
        path.join(workspaceRoot, 'scripts/public-site/build.mjs'),
        ...args,
    ], {
        cwd: workspaceRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            BLOG_DATA_ROOT: path.join(temporaryRoot, 'must-not-be-read'),
            NODE_ENV: 'production',
            NEXT_TELEMETRY_DISABLED: '1',
        },
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
    });
}

async function walkFiles(directory: string, prefix = ''): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const relativePath = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) return walkFiles(path.join(directory, entry.name), relativePath);
        return [relativePath];
    }));
    return nested.flat().sort();
}

let buildResult: ReturnType<typeof runBuild>;
let artifactPath: string;
let beforeBuildHashes: Map<string, string>;

beforeAll(async () => {
    await fs.mkdir(path.join(temporaryRoot, 'media'), { recursive: true });
    await fs.mkdir(path.join(temporaryRoot, 'must-not-be-read'), { recursive: true });
    await sharp({ create: { width: 1, height: 1, channels: 4, background: '#c66' } }).png().toFile(path.join(temporaryRoot, 'media', 'article.png'));
    await fs.writeFile(path.join(temporaryRoot, 'must-not-be-read', 'draft.json'), '{"title":"draft-secret","content":"private draft-secret body"}', 'utf8');
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
    beforeBuildHashes = new Map<string, string>(await Promise.all([
        'src/app/page.tsx',
        'next.config.mjs',
        'package.json',
        'package-lock.json',
    ].map(async (relative): Promise<[string, string]> => [
        relative,
        createHash('sha256').update(await fs.readFile(path.join(workspaceRoot, relative))).digest('hex'),
    ])));
    buildResult = runBuild();
    artifactPath = path.join(artifactRoot, releaseId, 'app', 'out');
}, 600_000);

afterAll(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('isolated Next.js public artifact export', () => {
    it('builds the snapshot without changing the shared app or locked dependencies', async () => {
        expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
        for (const [relative, expectedHash] of beforeBuildHashes) {
            const actualHash = createHash('sha256')
                .update(await fs.readFile(path.join(workspaceRoot, relative)))
                .digest('hex');
            expect(actualHash).toBe(expectedHash);
        }
    });

    it('exports the shared public UI with the frozen post, image, navigation and search fields', async () => {
        expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
        const files = await walkFiles(artifactPath);
        expect(files).toEqual(expect.arrayContaining([
            'index.html',
            'blog/index.html',
            'navigation/index.html',
            'search/index.html',
            'posts/静态文章/index.html',
            'feed.xml',
            'sitemap.xml',
            'robots.txt',
            'manifest.webmanifest',
            'llms.txt',
            '404.html',
            `_site/${releaseId}/favicon-32.png`,
            `_site/${releaseId}/og/静态文章.png`,
            `_site/${releaseId}/og/无封面文章.png`,
            'blog/legacy-post/index.html',
            'posts/旧文章/index.html',
            'search-index.json',
            `_site/${releaseId}/media/article.png`,
        ]));

        const html = await fs.readFile(path.join(artifactPath, 'posts', '静态文章', 'index.html'), 'utf8');
        const search = await fs.readFile(path.join(artifactPath, 'search-index.json'), 'utf8');
        const feed = await fs.readFile(path.join(artifactPath, 'feed.xml'), 'utf8');
        const sitemap = await fs.readFile(path.join(artifactPath, 'sitemap.xml'), 'utf8');
        const robots = await fs.readFile(path.join(artifactPath, 'robots.txt'), 'utf8');
        const manifest = await fs.readFile(path.join(artifactPath, 'manifest.webmanifest'), 'utf8');
        const llms = await fs.readFile(path.join(artifactPath, 'llms.txt'), 'utf8');
        expect(html).toContain('冻结文章标题');
        expect(html).toContain(`/_site/${releaseId}/media/article.png`);
        expect(search).toContain('冻结导航项');
        expect(search).toContain('冻结文章标题');
        expect(search).not.toContain('must-not-be-read');
        expect(matchesPublicSearchDocument(JSON.parse(search).documents[0], '中文')).toBe(true);
        expect(matchesPublicSearchDocument(JSON.parse(search).documents[0], '不存在的检索词')).toBe(false);
        expect(feed).toContain('https://guanlangzg.github.io/posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/');
        expect(sitemap).toContain('https://guanlangzg.github.io/posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/');
        expect(feed + sitemap + robots + search).not.toContain('draft-secret');
        expect(robots).toContain('https://guanlangzg.github.io/sitemap.xml');
        expect(manifest).toContain(`/_site/${releaseId}/favicon-32.png`);
        expect(llms).toContain('# 观澜志 G01');
        expect(llms).toContain('来自冻结快照的静态公开站');
        const sitemapEntries = sitemap.split('<url>').slice(1).map((entry) => entry.split('</url>')[0]);
        const fixedPages = sitemapEntries.filter((entry) => entry.includes('https://guanlangzg.github.io/') && !entry.includes('/posts/'));
        expect(fixedPages).toHaveLength(4);
        expect(fixedPages.every((entry) => !entry.includes('<lastmod>'))).toBe(true);
        const postEntry = sitemapEntries.find((entry) => entry.includes('/posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/'));
        expect(postEntry).toContain('<lastmod>2026-09-30</lastmod>');
    });

    it('renders removed legacy paths while preserving the current blog archive', async () => {
        const removed = await fs.readFile(path.join(artifactPath, 'blog', 'legacy-post', 'index.html'), 'utf8');
        const archive = await fs.readFile(path.join(artifactPath, 'blog', 'index.html'), 'utf8');
        expect(removed).toContain('内容已移除');
        expect(removed).toContain('href="/"');
        expect(removed).toContain('href="/search/"');
        expect(archive).toContain('冻结文章标题');
    });

    it('writes escaped no-loop redirect HTML for a renamed path', async () => {
        const redirect = await fs.readFile(path.join(artifactPath, 'posts', '旧文章', 'index.html'), 'utf8');
        expect(redirect).toContain('https://guanlangzg.github.io/posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/');
        expect(redirect).toContain('&amp;y=');
        expect(redirect).not.toContain('<script>alert(1)</script>');
        expect(redirect).not.toContain('https://guanlangzg.github.io/posts/旧文章/');
    });

    it('emits page-bound executable script hashes for the sealed HTML', async () => {
        expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
        const manifest = JSON.parse(await fs.readFile(path.join(artifactRoot, releaseId, 'artifacts.json'), 'utf8')) as {
            files: Array<{ path: string; inlineScriptHashes?: string[] }>;
        };
        const artifactPaths = manifest.files.map((entry) => entry.path);
        expect(artifactPaths).toEqual(expect.arrayContaining([
            'app/out/feed.xml',
            'app/out/sitemap.xml',
            'app/out/robots.txt',
            'app/out/404.html',
            `app/out/_site/${releaseId}/og/静态文章.png`,
            `app/out/_site/${releaseId}/og/无封面文章.png`,
            'app/out/blog/legacy-post/index.html',
            'app/out/posts/旧文章/index.html',
        ]));
        const postEntry = manifest.files.find((entry) => entry.path === 'app/out/posts/静态文章/index.html');
        expect(postEntry?.inlineScriptHashes?.length).toBeGreaterThan(0);
        expect(postEntry?.inlineScriptHashes?.every((hash) => hash.startsWith('sha256-'))).toBe(true);
    });

    it('requires authorization for HTML, JavaScript, media, index and RSC/prefetch artifacts', async () => {
        const manifest = JSON.parse(await fs.readFile(path.join(artifactRoot, releaseId, 'artifacts.json'), 'utf8')) as {
            files: Array<{ path: string }>;
        };
        const script = manifest.files.find((entry) => entry.path.endsWith('.js'))?.path.slice('app/out/'.length);
        expect(script).toBeTruthy();
        const paths = [
            'posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/index.html',
            script!,
            `_site/${releaseId}/media/article.png`,
            'search-index.json',
            'posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/index.txt',
        ];
        const responses = await Promise.all(paths.map((relativePath) => servePreviewArtifact({
            authorized: false,
            requestedReleaseId: releaseId,
            expectedReleaseId: releaseId,
            activeReleaseId: releaseId,
            previewRelease: releaseId,
            relativePath,
            method: 'GET',
            releaseRoot: path.join(artifactRoot, releaseId),
        })));
        expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    });

    it('serves only the active release and preserves sealed bytes for GET and HEAD', async () => {
        const releaseRoot = path.join(artifactRoot, releaseId);
        const stale = await servePreviewArtifact({
            authorized: true,
            requestedReleaseId: releaseId,
            expectedReleaseId: releaseId,
            activeReleaseId: 'g01-new-active-release',
            previewRelease: releaseId,
            relativePath: 'search-index.json',
            method: 'GET',
            releaseRoot,
        });
        expect(stale.status).toBe(409);

        const htmlPath = path.join(artifactPath, 'posts', '静态文章', 'index.html');
        const originalBytes = await fs.readFile(htmlPath);
        const response = await servePreviewArtifact({
            authorized: true,
            requestedReleaseId: releaseId,
            expectedReleaseId: releaseId,
            activeReleaseId: releaseId,
            previewRelease: releaseId,
            relativePath: 'posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/index.html',
            method: 'GET',
            releaseRoot,
        });
        expect(Buffer.from(await response.arrayBuffer())).toEqual(originalBytes);
        expect(response.headers.get('content-security-policy')).toContain('script-src');
        expect(response.headers.get('cache-control')).toBe('private, no-store');

        const head = await servePreviewArtifact({
            authorized: true,
            requestedReleaseId: releaseId,
            expectedReleaseId: releaseId,
            activeReleaseId: releaseId,
            previewRelease: releaseId,
            relativePath: 'posts/%E9%9D%99%E6%80%81%E6%96%87%E7%AB%A0/index.html',
            method: 'HEAD',
            releaseRoot,
        });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        expect(head.headers.get('content-security-policy')).toBe(response.headers.get('content-security-policy'));
    });

    it('rejects output path traversal before starting a build', () => {
        const result = runBuild(['--snapshot', snapshotPath, '--out', `${temporaryRoot}\\..\\escaped`]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/output|out|path/i);
    });

    it('binds the sealed preview adapter to this artifact release in every exported page', async () => {
        expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
        const htmlPages = ['index.html', 'blog/index.html', 'navigation/index.html', 'search/index.html', 'posts/静态文章/index.html'];
        for (const page of htmlPages) {
            const html = await fs.readFile(path.join(artifactPath, page), 'utf8');
            expect(html, page).toContain(`/_site/${releaseId}/preview.js`);
            // Root-absolute Next assets would break the release-bound preview path.
            expect(html, page).not.toContain('"/_next/static');
            expect(html, page).toContain(`/_site/${releaseId}/_next/static`);
        }
    });

    it('keeps backend, environment and draft data out of the artifact closure', async () => {
        expect(buildResult.status, buildResult.stderr || buildResult.stdout).toBe(0);
        const files = await walkFiles(artifactPath);
        expect(files.some((file) => file.endsWith('.map'))).toBe(false);
        expect(files.some((file) => file.startsWith('api/'))).toBe(false);
        expect(files.some((file) => file.startsWith('editor/'))).toBe(false);
        expect(files.some((file) => file.startsWith('setup/'))).toBe(false);
        const allText = await Promise.all(files
            .filter((file) => /\.(html|json|js|css|txt)$/.test(file))
            .map((file) => fs.readFile(path.join(artifactPath, file), 'utf8')));
        const artifactText = allText.join('\n');
        expect(artifactText).not.toContain('BLOG_DATA_ROOT');
        expect(artifactText).not.toContain('must-not-be-read');
        expect(artifactText).not.toContain('draft-secret');
        expect(artifactText).not.toContain('/api/search');
        expect(artifactText).not.toContain('/api/editor-auth');
    });
});
