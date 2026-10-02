#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createArtifactManifest, getStaticAssetUrl, validatePublicSiteSnapshot } from '../../src/lib/public-build/runner.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const publicAssets = ['guanlan-logo.png', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'favicon-64.png'];
const maxSnapshotBytes = 4 * 1024 * 1024;
const SITE_ORIGIN = 'https://guanlangzg.github.io';
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function parseArguments(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (key !== '--snapshot' && key !== '--out') throw new Error(`Unknown option: ${key}`);
        if (values.has(key)) throw new Error(`Duplicate option: ${key}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
        if (value.split(/[\\/]/).includes('..')) throw new Error(`Path traversal is not allowed for ${key}`);
        values.set(key, path.resolve(value));
        index += 1;
    }
    if (!values.has('--snapshot') || !values.has('--out')) {
        throw new Error('Usage: node scripts/public-site/build.mjs --snapshot <frozen.json> --out <new-artifact-root>');
    }
    return { snapshotPath: values.get('--snapshot'), outputRoot: values.get('--out') };
}

function buildEnvironment(snapshotPath, releaseId) {
    const environment = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) {
        if (process.env[key]) environment[key] = process.env[key];
    }
    return {
        ...environment,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        PUBLIC_SITE_SNAPSHOT_PATH: snapshotPath,
        PUBLIC_RELEASE_ID: releaseId,
    };
}

function createNextConfig(releaseId) {
    return `const releaseId = process.env.PUBLIC_RELEASE_ID;\nif (releaseId !== ${JSON.stringify(releaseId)}) throw new Error('PUBLIC_RELEASE_ID mismatch');\nexport default { output: 'export', trailingSlash: true, images: { unoptimized: true }, assetPrefix: ${JSON.stringify(`/_site/${releaseId}`)}, poweredByHeader: false, eslint: { ignoreDuringBuilds: true } };\n`;
}

function createTailwindConfig() {
    const configPath = pathToFileURL(path.join(projectRoot, 'tailwind.config.ts')).href;
    const content = [
        './src/app/**/*.{js,ts,jsx,tsx,mdx}',
        './src/public-site/**/*.{js,ts,jsx,tsx,mdx}',
    ];
    return `import baseConfig from ${JSON.stringify(configPath)};\nexport default { ...baseConfig, content: ${JSON.stringify(content)} };\n`;
}

function createPreviewAdapter(releaseId) {
    return `(()=>{const release=${JSON.stringify(releaseId)};const show=()=>{let banner=document.getElementById('preview-expired');if(!banner){banner=document.createElement('div');banner.id='preview-expired';banner.className='preview-expired';banner.setAttribute('role','alert');banner.textContent='此预览版本已过期，请重新打开当前版本。';document.body.append(banner)}};const current=()=>new URL(location.href).searchParams.get('previewRelease');const stale=()=>Boolean(current()&&current()!==release);document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(!link)return;const target=new URL(link.href,location.href);if(target.origin!==location.origin||target.pathname.startsWith('/editor')||target.pathname.startsWith('/api/'))return;if(stale()){event.preventDefault();event.stopImmediatePropagation();show();return}if(current())target.searchParams.set('previewRelease',release);link.href=target.pathname+target.search+target.hash},{capture:true});window.addEventListener('pageshow',()=>{if(stale())show()});if(stale())show()})();`;
}

function publicOgPath(releaseId, post) {
    return `_site/${releaseId}/og/${post.slug}.png`;
}

function rewriteManagedMarkdown(content, sourcePath, targetPath) {
    const source = sourcePath.replaceAll('\\\\', '/');
    const target = targetPath.replaceAll('\\\\', '/');
    const rewriteSegment = (segment) => segment.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (full, prefix, rawTarget, suffix) => {
        const parsed = /^([^?#]*)([?#].*)?$/.exec(rawTarget);
        return parsed && parsed[1] === source ? `${prefix}${target}${parsed[2] || ''}${suffix}` : full;
    });
    const fenced = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
    let cursor = 0;
    let output = '';
    for (const match of content.matchAll(fenced)) {
        const start = match.index ?? 0;
        output += rewriteSegment(content.slice(cursor, start));
        output += match[0];
        cursor = start + match[0].length;
    }
    return output + rewriteSegment(content.slice(cursor));
}

async function assertRegularFile(filePath, label) {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

async function assertNewOutputDirectory(outputRoot) {
    const parentPath = path.dirname(outputRoot);
    const parentInfo = await fs.lstat(parentPath);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('Output parent must be a real directory');
    if (await fs.realpath(parentPath) !== parentPath) throw new Error('Output parent cannot be a symlink path');
    const relative = path.relative(projectRoot, outputRoot);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        const segments = relative.split(path.sep);
        if (segments[0] !== '.tmp' || segments.length < 3) {
            throw new Error('Output root inside the project must be under .tmp/');
        }
    }
    try {
        await fs.lstat(outputRoot);
        throw new Error('Output root already exists; refusing to overwrite it');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

function safeRelativeSegments(value, label) {
    const normalized = String(value).replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (normalized.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Invalid ${label} path`);
    }
    return segments;
}

async function copyFrozenMedia({ snapshotDirectory, releasePublic, source, publicPath, expected, label }) {
    const sourceSegments = safeRelativeSegments(source, `${label} source`);
    const targetSegments = safeRelativeSegments(publicPath, `${label} public`);
    if (sourceSegments[0] !== 'media' || sourceSegments.length < 2 || targetSegments[0] !== 'media' || targetSegments.length < 2) {
        throw new Error(`${label} must remain under media/`);
    }
    const sourcePath = path.resolve(snapshotDirectory, ...sourceSegments);
    const relativeFromSnapshot = path.relative(snapshotDirectory, sourcePath);
    if (relativeFromSnapshot.startsWith('..') || path.isAbsolute(relativeFromSnapshot)) throw new Error(`${label} escapes frozen snapshot directory`);
    await assertRegularFile(sourcePath, label);
    const bytes = await fs.readFile(sourcePath);
    if (expected && (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256)) {
        throw new Error(`${label} bytes do not match the frozen media identity`);
    }
    const targetPath = path.join(releasePublic, ...targetSegments);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
        await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(targetPath);
        if (!Buffer.from(existing).equals(bytes)) throw new Error(`${label} target has different bytes`);
    }
}

async function writePublicShell(buildRoot, snapshot, snapshotPath) {
    const releasePublic = path.join(buildRoot, 'public', '_site', snapshot.releaseId);
    await fs.mkdir(releasePublic, { recursive: true });
    for (const file of publicAssets) {
        const source = path.join(projectRoot, 'public', file);
        await assertRegularFile(source, `public asset ${file}`);
        await fs.copyFile(source, path.join(releasePublic, file), fsConstants.COPYFILE_EXCL);
    }
    await fs.writeFile(path.join(releasePublic, 'preview.js'), createPreviewAdapter(snapshot.releaseId), { flag: 'wx' });
    const snapshotDirectory = path.dirname(snapshotPath);
    for (const media of snapshot.media ?? []) {
        await copyFrozenMedia({
            snapshotDirectory,
            releasePublic,
            source: media.source,
            publicPath: media.publicPath,
            expected: media,
            label: `managed media ${media.source}`,
        });
    }
    for (const post of snapshot.posts) {
        if (!post.managedImage) continue;
        const sourceRelative = post.managedImage.source.replaceAll('\\', '/');
        const sourceSegments = safeRelativeSegments(sourceRelative, `managed image for ${post.slug}`);
        if (sourceSegments[0] !== 'media' || sourceSegments.length < 2) throw new Error(`Managed image source must be under media/: ${post.slug}`);
        const mediaRelative = sourceSegments.slice(1).join('/');
        await copyFrozenMedia({
            snapshotDirectory,
            releasePublic,
            source: sourceRelative,
            publicPath: `media/${mediaRelative}`,
            label: `managed image for ${post.slug}`,
        });
        const sourceImagePath = `/media/${mediaRelative.split('/').map(encodeURIComponent).join('/')}`;
        const publicImagePath = getStaticAssetUrl(snapshot.releaseId, `media/${mediaRelative}`);
        post.content = rewriteManagedMarkdown(post.content, sourceImagePath, publicImagePath);
    }
    await fs.writeFile(path.join(buildRoot, 'snapshot.json'), JSON.stringify({
        releaseId: snapshot.releaseId,
        site: snapshot.site,
        posts: snapshot.posts,
        navigation: snapshot.navigation,
        ...(snapshot.redirects ? { redirects: snapshot.redirects } : {}),
        ...(snapshot.removedPaths ? { removedPaths: snapshot.removedPaths } : {}),
    }), { flag: 'wx' });
}

function createShareCardSvg(siteTitle, postTitle) {
    const lines = Array.from(postTitle).reduce((result, character) => {
        const current = result[result.length - 1];
        if (!current || Array.from(current).length >= 18) result.push(character);
        else result[result.length - 1] += character;
        return result;
    }, []);
    const titleLines = lines.slice(0, 3).map((line, index) => `<text x="84" y="${300 + index * 76}" font-size="58" font-weight="700">${escapeHtml(line)}</text>`).join('');
    return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f7f8f5"/><stop offset="1" stop-color="#efebe3"/></linearGradient></defs><rect width="1200" height="630" fill="url(#paper)"/><rect x="42" y="42" width="1116" height="546" rx="28" fill="#fbfbf8" stroke="#e3e6de" stroke-width="2"/><rect x="84" y="104" width="8" height="68" rx="4" fill="#b85c38"/><text x="116" y="150" font-family="sans-serif" font-size="30" fill="#5f5a54">${escapeHtml(siteTitle)}</text>${titleLines}<text x="84" y="526" font-family="sans-serif" font-size="24" fill="#8b8378">guanlangzg.github.io</text></svg>`;
}

function createCoverOverlaySvg(siteTitle, postTitle) {
    const lines = Array.from(postTitle).reduce((result, character) => {
        const current = result[result.length - 1];
        if (!current || Array.from(current).length >= 18) result.push(character);
        else result[result.length - 1] += character;
        return result;
    }, []);
    const titleLines = lines.slice(0, 3).map((line, index) => `<text x="84" y="${365 + index * 70}" font-size="56" font-weight="700">${escapeHtml(line)}</text>`).join('');
    return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="630" fill="#1a1917" fill-opacity="0.64"/><rect x="42" y="42" width="1116" height="546" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="2"/><text x="84" y="150" font-family="sans-serif" font-size="30" fill="#ffffff">${escapeHtml(siteTitle)}</text>${titleLines}<text x="84" y="540" font-family="sans-serif" font-size="24" fill="#ffffff">guanlangzg.github.io</text></svg>`;
}

function publicOutputPath(root, route) {
    const pathname = new URL(route, SITE_ORIGIN).pathname;
    const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) throw new Error(`Invalid public artifact route: ${route}`);
    return path.join(root, ...segments, 'index.html');
}

async function writeRemovedPages(outputRoot, removedPaths) {
    for (const route of removedPaths ?? []) {
        if (!route.toLowerCase().startsWith('/blog/')) continue;
        const filePath = publicOutputPath(outputRoot, route);
        await assertRegularFile(filePath, `removed legacy page ${route}`);
        const html = await fs.readFile(filePath, 'utf8');
        if (!html.includes('内容已移除') || !html.includes('href="/"') || !html.includes('href="/search/"')) {
            throw new Error(`Removed legacy page is missing its shared removal view: ${route}`);
        }
    }
}

function assertLocalRoute(route, label) {
    if (typeof route !== 'string' || route.length === 0 || route.startsWith('//') || route.includes('\\')) {
        throw new Error(`${label} must be a local site path`);
    }
    if (!route.startsWith('/')) throw new Error(`${label} must be a local site path`);
    for (let index = 0; index < route.length; index += 1) {
        const code = route.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) throw new Error(`${label} contains a control character`);
    }
    return route;
}

async function writeRedirectPages(outputRoot, redirects) {
    for (const redirect of redirects ?? []) {
        const from = assertLocalRoute(redirect.from, 'redirect.from');
        const to = assertLocalRoute(redirect.to, 'redirect.to');
        const target = new URL(to, SITE_ORIGIN);
        if (target.origin !== SITE_ORIGIN || target.username || target.password) {
            throw new Error(`Redirect target must stay on the public site: ${from}`);
        }
        if (target.pathname === new URL(from, SITE_ORIGIN).pathname) {
            throw new Error(`Redirect loop: ${from}`);
        }
        // `URL` percent-encodes the path (Chinese slugs) and the query so the shell
        // document never carries raw markup; escaping happens once at output time.
        const targetUrl = `${SITE_ORIGIN}${target.pathname}${target.search}${target.hash}`;
        const filePath = publicOutputPath(outputRoot, from);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${escapeHtml(targetUrl)}"><title>页面已更名</title></head><body><main><h1>页面已更名</h1><p>此静态页面会跳转到新地址。</p><p><a href="${escapeHtml(targetUrl)}">继续访问</a></p></main></body></html>`;
        await fs.writeFile(filePath, html, { flag: 'wx' });
    }
}

async function writeShareImages(outputRoot, snapshot, snapshotPath) {
    for (const post of snapshot.posts) {
        const svg = Buffer.from(createShareCardSvg(snapshot.site.title, post.title));
        const image = sharp(svg).resize(1200, 630).png();
        const outputFile = path.join(outputRoot, ...publicOgPath(snapshot.releaseId, post).split('/'));
        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        if (post.managedImage) {
            const sourceSegments = post.managedImage.source.replaceAll('\\', '/').split('/');
            const coverPath = path.resolve(path.dirname(snapshotPath), ...sourceSegments);
            const coverBytes = await fs.readFile(coverPath);
            const overlay = Buffer.from(createCoverOverlaySvg(snapshot.site.title, post.title));
            await sharp(coverBytes).resize(1200, 630, { fit: 'cover' }).composite([{ input: overlay }]).png().toFile(outputFile);
        } else {
            await image.toFile(outputFile);
        }
    }
}

async function copyDirectory(source, target) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

async function createBuildWorkspace(buildRoot, snapshot) {
    // The legacy-removed catch-all route only prerenders pages when the snapshot
    // actually carries /blog/ removed paths; with none, Next 15 export mode would
    // reject the empty dynamic route, so the route is only copied when needed.
    const hasRemovedBlogPaths = (snapshot.removedPaths ?? [])
        .some((route) => String(route).toLowerCase().startsWith('/blog/'));
    const sourceFiles = [
        ['src/public-site/app/layout.tsx', 'src/app/layout.tsx'],
        ['src/public-site/app/globals.css', 'src/app/globals.css'],
        ['src/public-site/app/page.tsx', 'src/app/page.tsx'],
        ['src/public-site/app/blog/page.tsx', 'src/app/blog/page.tsx'],
        ...(hasRemovedBlogPaths
            ? [['src/public-site/app/blog/[...slug]/page.tsx', 'src/app/blog/[...slug]/page.tsx']]
            : []),
        ['src/public-site/app/navigation/page.tsx', 'src/app/navigation/page.tsx'],
        ['src/public-site/app/search/page.tsx', 'src/app/search/page.tsx'],
        ['src/public-site/app/search-index.json/route.ts', 'src/app/search-index.json/route.ts'],
        ['src/public-site/app/feed.xml/route.ts', 'src/app/feed.xml/route.ts'],
        ['src/public-site/app/sitemap.ts', 'src/app/sitemap.ts'],
        ['src/public-site/app/manifest.ts', 'src/app/manifest.ts'],
        ['src/public-site/app/llms.txt/route.ts', 'src/app/llms.txt/route.ts'],
        ['src/public-site/app/robots.ts', 'src/app/robots.ts'],
        ['src/public-site/app/not-found.tsx', 'src/app/not-found.tsx'],
        ['src/public-site/app/posts/[slug]/page.tsx', 'src/app/posts/[slug]/page.tsx'],
        ['src/public-site/search-index.ts', 'src/public-site/search-index.ts'],
        ['src/public-site/types.ts', 'src/public-site/types.ts'],
        ['src/public-site/snapshot.ts', 'src/public-site/snapshot.ts'],
        ['src/public-site/paths.ts', 'src/public-site/paths.ts'],
        ['src/public-site/components/SiteHeader.tsx', 'src/public-site/components/SiteHeader.tsx'],
        ['src/public-site/components/SearchView.tsx', 'src/public-site/components/SearchView.tsx'],
        ['src/public-site/components/ThemeInitScript.tsx', 'src/public-site/components/ThemeInitScript.tsx'],
        ['src/public-site/components/LegacyRemovedView.tsx', 'src/public-site/components/LegacyRemovedView.tsx'],
        ['src/public-site/views/HomeView.tsx', 'src/public-site/views/HomeView.tsx'],
        ['src/app/components/ui/PostCard.tsx', 'src/app/components/ui/PostCard.tsx'],
        ['src/app/components/ui/PageHero.tsx', 'src/app/components/ui/PageHero.tsx'],
        ['src/app/components/markdown/MarkdownContent.tsx', 'src/app/components/markdown/MarkdownContent.tsx'],
        ['src/app/components/markdown/CopyCodeButton.tsx', 'src/app/components/markdown/CopyCodeButton.tsx'],
        ['src/app/components/theme/ThemeToggle.tsx', 'src/app/components/theme/ThemeToggle.tsx'],
        ['src/app/components/theme/useTheme.ts', 'src/app/components/theme/useTheme.ts'],
        ['src/app/styles/design-tokens.css', 'src/app/styles/design-tokens.css'],
        ['src/app/styles/markdown-preview.css', 'src/app/styles/markdown-preview.css'],
        ['src/app/types/article.ts', 'src/app/types/article.ts'],
        ['src/lib/utils.ts', 'src/lib/utils.ts'],
        ['src/lib/article-quality.ts', 'src/lib/article-quality.ts'],
        ['src/lib/article-metadata.ts', 'src/lib/article-metadata.ts'],
        ['src/lib/url-safety.ts', 'src/lib/url-safety.ts'],
        ['src/lib/search-query.ts', 'src/lib/search-query.ts'],
    ];
    for (const [source, target] of sourceFiles) {
        await copyDirectory(path.join(projectRoot, source), path.join(buildRoot, target));
    }
    // A workspace outside the project tree cannot resolve react/next by walking up
    // (e.g. the container build volume), so link the locked dependency set in.
    const relativeToProject = path.relative(projectRoot, buildRoot);
    if (relativeToProject.startsWith('..') || path.isAbsolute(relativeToProject)) {
        await fs.symlink(
            path.join(projectRoot, 'node_modules'),
            path.join(buildRoot, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
    }
    await fs.writeFile(path.join(buildRoot, 'next-env.d.ts'), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n', { flag: 'wx' });
    await fs.writeFile(path.join(buildRoot, 'next.config.mjs'), createNextConfig(snapshot.releaseId), { flag: 'wx' });
    await fs.writeFile(path.join(buildRoot, 'package.json'), JSON.stringify({ name: 'g01-isolated-public-export', private: true, type: 'module' }), { flag: 'wx' });
    const tsconfig = {
        compilerOptions: {
            baseUrl: '.', target: 'ES2020', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true,
            skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext',
            moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve',
            plugins: [{ name: 'next' }],
            paths: { '@/app/*': ['./src/app/*'], '@/lib/*': ['./src/lib/*'], '@/public-site/*': ['./src/public-site/*'] },
        },
        include: ['next-env.d.ts', '.next/types/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['node_modules'],
    };
    await fs.writeFile(path.join(buildRoot, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), { flag: 'wx' });
    await fs.writeFile(path.join(buildRoot, 'tailwind.config.ts'), createTailwindConfig(), { flag: 'wx' });
    await fs.copyFile(path.join(projectRoot, 'postcss.config.mjs'), path.join(buildRoot, 'postcss.config.mjs'), fsConstants.COPYFILE_EXCL);
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function createSealedRelease(releaseRoot, snapshot, rawSnapshot) {
    const markerPath = path.join(releaseRoot, 'app', 'out', '_release.json');
    const candidateDigest = sha256(rawSnapshot);
    const beforeMarker = await createArtifactManifest(releaseRoot, snapshot.releaseId, new Set(['artifacts.json', `app/out/_release.json`]), candidateDigest);
    await fs.writeFile(markerPath, JSON.stringify({ releaseId: snapshot.releaseId, candidateDigest, artifactDigest: beforeMarker.artifactDigest }), { flag: 'wx' });
    const manifest = await createArtifactManifest(releaseRoot, snapshot.releaseId, new Set(['artifacts.json']), candidateDigest);
    if (manifest.artifactDigest !== beforeMarker.artifactDigest) throw new Error('Release marker changed the artifact digest');
    await fs.writeFile(path.join(releaseRoot, 'artifacts.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const entry of manifest.files) {
        const filePath = path.join(releaseRoot, ...entry.path.split('/'));
        const bytes = await fs.readFile(filePath);
        if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`Artifact integrity mismatch: ${entry.path}`);
    }
}

// Moves a directory even when the target lives on another volume or when a
// Windows file handle briefly blocks `rename`.
async function moveDirectory(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
        await fs.rename(from, to);
        return;
    } catch (error) {
        const code = error.code;
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error;
    }
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(from, { recursive: true, force: true });
}

async function main() {
    const { snapshotPath, outputRoot } = parseArguments(process.argv.slice(2));
    await assertRegularFile(snapshotPath, 'snapshot');
    const snapshotInfo = await fs.stat(snapshotPath);
    if (snapshotInfo.size > maxSnapshotBytes) throw new Error('Frozen snapshot exceeds 4 MiB');
    const rawSnapshot = await fs.readFile(snapshotPath);
    const snapshot = validatePublicSiteSnapshot(JSON.parse(rawSnapshot.toString('utf8')));
    await assertNewOutputDirectory(outputRoot);

    const parentPath = path.dirname(outputRoot);
    const stagingRoot = await fs.mkdtemp(path.join(parentPath, `.${path.basename(outputRoot)}.g01-`));
    const releaseRoot = path.join(stagingRoot, snapshot.releaseId);
    await fs.mkdir(releaseRoot);
    // The build workspace belongs in BLOG_BUILD_ROOT so container runs keep it on the
    // dedicated build volume instead of inside the application source tree.
    const buildWorkspaceParent = process.env.BLOG_BUILD_ROOT?.trim()
        ? path.resolve(process.env.BLOG_BUILD_ROOT)
        : projectRoot;
    await fs.mkdir(buildWorkspaceParent, { recursive: true });
    const buildRoot = await fs.mkdtemp(path.join(buildWorkspaceParent, '.g01-public-site-'));
    try {
        await createBuildWorkspace(buildRoot, snapshot);
        await writePublicShell(buildRoot, snapshot, snapshotPath);
        const result = spawnSync(process.execPath, [nextBin, 'build', buildRoot], {
            cwd: projectRoot,
            env: buildEnvironment(path.join(buildRoot, 'snapshot.json'), snapshot.releaseId),
            encoding: 'utf8',
            timeout: 600_000,
            maxBuffer: 64 * 1024 * 1024,
        });
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Next.js static export failed with status ${result.status}`);

        const exportRoot = path.join(buildRoot, 'out');
        await fs.access(exportRoot);
        const staticAssets = path.join(exportRoot, '_next', 'static');
        const releaseStatic = path.join(exportRoot, '_site', snapshot.releaseId, '_next', 'static');
        await fs.mkdir(path.dirname(releaseStatic), { recursive: true });
        await moveDirectory(staticAssets, releaseStatic);
        await fs.mkdir(path.join(releaseRoot, 'app'));
        const appOutputRoot = path.join(releaseRoot, 'app', 'out');
        await moveDirectory(exportRoot, appOutputRoot);
        await writeRemovedPages(appOutputRoot, snapshot.removedPaths);
        await writeRedirectPages(appOutputRoot, snapshot.redirects);
        await writeShareImages(appOutputRoot, snapshot, snapshotPath);
        await createSealedRelease(releaseRoot, snapshot, rawSnapshot);

        const outputStat = await fs.lstat(outputRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (outputStat) throw new Error('Output root appeared during build; refusing to overwrite it');
        await moveDirectory(stagingRoot, outputRoot);
        process.stdout.write(`Static release ${snapshot.releaseId} sealed.\n`);
    } finally {
        await fs.rm(buildRoot, { recursive: true, force: true });
        await fs.rm(stagingRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
