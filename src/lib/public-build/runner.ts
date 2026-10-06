import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PublicArtifactManifest, PublicSiteSnapshot } from '@/public-site/types';

const RELEASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const TOP_LEVEL_KEYS = new Set(['releaseId', 'site', 'posts', 'navigation', 'redirects', 'removedPaths', 'media']);
const REDIRECT_KEYS = new Set(['from', 'to']);
const PUBLIC_PATH_RESERVED = new Set(['api', 'editor', 'feed.xml', 'navigation', 'og', 'robots.txt', 'search', 'setup', 'sitemap.xml']);
const SITE_KEYS = new Set(['title', 'description']);
const POST_KEYS = new Set(['slug', 'title', 'description', 'date', 'tags', 'content', 'managedImage']);
const IMAGE_KEYS = new Set(['source', 'alt']);
const MEDIA_KEYS = new Set(['source', 'publicPath', 'sha256', 'size', 'mimeType']);
const NAVIGATION_KEYS = new Set(['name', 'items']);
const NAVIGATION_ITEM_KEYS = new Set(['title', 'description', 'url', 'tags']);

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
    return value;
}

function validateSlug(slug: unknown): string {
    const value = requiredString(slug, 'post slug');
    let decoded = value;
    for (let depth = 0; depth < 5; depth += 1) {
        if (decoded.includes('/') || decoded.includes('\\')) throw new Error(`Invalid post slug separator: ${value}`);
        let next: string;
        try { next = decodeURIComponent(decoded); } catch { throw new Error(`Invalid encoded post slug: ${value}`); }
        if (next === decoded) return value;
        decoded = next;
    }
    throw new Error(`Invalid over-encoded post slug: ${value}`);
}

function validateReleaseId(value: unknown): string {
    const releaseId = requiredString(value, 'releaseId');
    if (!RELEASE_ID_PATTERN.test(releaseId) || releaseId === '.' || releaseId === '..') throw new Error('Invalid releaseId');
    return releaseId;
}

function hasC0ControlCharacter(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 0 && codePoint <= 0x1f;
    });
}

function validateLocalTarget(value: unknown, label: string): string {
    const target = requiredString(value, label);
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || hasC0ControlCharacter(target)) {
        throw new Error(`${label} must be a local absolute URL`);
    }
    let parsed: URL;
    try { parsed = new URL(target, 'https://guanlangzg.github.io'); } catch { throw new Error(`${label} is invalid`); }
    if (parsed.origin !== 'https://guanlangzg.github.io' || parsed.username || parsed.password) throw new Error(`${label} must remain on the public site`);
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(parsed.pathname); } catch { throw new Error(`${label} has invalid path encoding`); }
    if (decodedPath.includes('\\') || decodedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new Error(`${label} contains an invalid path segment`);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function validatePublicPath(value: unknown, label: string, allowRemovedPath = false): string {
    const route = requiredString(value, label);
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\') || route.includes('?') || route.includes('#') || hasC0ControlCharacter(route)) {
        throw new Error(`${label} must be a local absolute path`);
    }
    let decoded: string;
    try { decoded = decodeURIComponent(route); } catch { throw new Error(`${label} has invalid encoding`); }
    if (decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new Error(`${label} contains an invalid path segment`);
    }
    const segments = decoded.split('/').filter(Boolean);
    const reserved = segments.length > 0 && PUBLIC_PATH_RESERVED.has(segments[0].toLowerCase());
    const allowReservedForRemoval = allowRemovedPath
        && ['blog', 'posts'].includes(segments[0]?.toLowerCase() ?? '')
        && segments.length === 2;
    if (!segments.length || (reserved && !allowReservedForRemoval)) throw new Error(`${label} uses a reserved public path`);
    if (allowRemovedPath && !allowReservedForRemoval) {
        throw new Error(`${label} must be a /posts/<slug>/ or legacy /blog/<slug>/ path`);
    }
    return route;
}

function resolveRedirects(value: unknown): PublicSiteSnapshot['redirects'] {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error('redirects must be an array');
    const redirects = value.map((entry, index) => {
        const redirect = asRecord(entry, `redirects[${index}]`);
        assertKeys(redirect, REDIRECT_KEYS, `redirects[${index}]`);
        const from = validatePublicPath(redirect.from, `redirects[${index}].from`);
        const to = validateLocalTarget(redirect.to, `redirects[${index}].to`);
        const normalizedTarget = new URL(to, 'https://guanlangzg.github.io').pathname;
        if (from === normalizedTarget || from === to) throw new Error(`Redirect loop detected for ${from}`);
        return { from, to };
    });
    const targetBySource = new Map(redirects.map(({ from, to }) => [from, new URL(to, 'https://guanlangzg.github.io').pathname]));
    for (const { from } of redirects) {
        const seen = new Set([from]);
        let target = targetBySource.get(from);
        while (target && targetBySource.has(target)) {
            if (seen.has(target)) throw new Error(`Redirect loop detected for ${from}`);
            seen.add(target);
            target = targetBySource.get(target);
        }
    }
    return redirects;
}

function resolveRemovedPaths(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error('removedPaths must be an array');
    const paths = value.map((route, index) => validatePublicPath(route, `removedPaths[${index}]`, true));
    if (new Set(paths).size !== paths.length) throw new Error('removedPaths contains duplicate paths');
    return paths;
}

/** The artifact export writes one file per path, so each path may have exactly one owner. */
function assertSinglePathOwner(snapshot: PublicSiteSnapshot): void {
    const owners = new Map<string, string>();
    const claim = (route: string, owner: string) => {
        const key = decodeURIComponent(route).replace(/\/+$/, '');
        const existing = owners.get(key);
        if (existing) throw new Error(`${owner} and ${existing} both claim the public path ${route}`);
        owners.set(key, owner);
    };
    for (const post of snapshot.posts) claim(`/posts/${encodeURIComponent(post.slug)}/`, 'an article page');
    for (const redirect of snapshot.redirects ?? []) claim(redirect.from, 'a rename redirect');
    for (const route of snapshot.removedPaths ?? []) claim(route, 'a removal notice');
}

export function validatePublicSiteSnapshot(value: unknown): PublicSiteSnapshot {
    const snapshot = asRecord(value, 'snapshot');
    assertKeys(snapshot, TOP_LEVEL_KEYS, 'snapshot');
    const releaseId = validateReleaseId(snapshot.releaseId);
    const site = asRecord(snapshot.site, 'site');
    assertKeys(site, SITE_KEYS, 'site');
    if (!Array.isArray(snapshot.posts) || !Array.isArray(snapshot.navigation)) throw new Error('snapshot.posts and snapshot.navigation must be arrays');
    if (snapshot.media !== undefined && (!Array.isArray(snapshot.media) || snapshot.media.some((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
        const media = value as Record<string, unknown>;
        return Object.keys(media).some((key) => !MEDIA_KEYS.has(key))
            || typeof media.source !== 'string' || typeof media.publicPath !== 'string'
            || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(media.sha256)
            || typeof media.size !== 'number' || !Number.isSafeInteger(media.size) || media.size < 0
            || typeof media.mimeType !== 'string';
    }))) throw new Error('snapshot.media must contain valid managed media records');
    const slugs = new Set<string>();
    const posts = snapshot.posts.map((value, index) => {
        const post = asRecord(value, `posts[${index}]`);
        assertKeys(post, POST_KEYS, `posts[${index}]`);
        const slug = validateSlug(post.slug);
        if (slugs.has(slug)) throw new Error(`Duplicate post slug: ${slug}`);
        slugs.add(slug);
        if (!Array.isArray(post.tags) || post.tags.some((tag) => typeof tag !== 'string')) throw new Error(`posts[${index}].tags must be a string array`);
        let managedImage: PublicSiteSnapshot['posts'][number]['managedImage'];
        if (post.managedImage !== undefined) {
            const image = asRecord(post.managedImage, `posts[${index}].managedImage`);
            assertKeys(image, IMAGE_KEYS, `posts[${index}].managedImage`);
            managedImage = { source: requiredString(image.source, `posts[${index}].managedImage.source`), alt: requiredString(image.alt, `posts[${index}].managedImage.alt`) };
        }
        return {
            slug,
            title: requiredString(post.title, `posts[${index}].title`),
            description: requiredString(post.description, `posts[${index}].description`),
            date: requiredString(post.date, `posts[${index}].date`),
            tags: [...post.tags] as string[],
            content: requiredString(post.content, `posts[${index}].content`),
            ...(managedImage ? { managedImage } : {}),
        };
    });
    const navigation = snapshot.navigation.map((value, index) => {
        const group = asRecord(value, `navigation[${index}]`);
        assertKeys(group, NAVIGATION_KEYS, `navigation[${index}]`);
        if (!Array.isArray(group.items)) throw new Error(`navigation[${index}].items must be an array`);
        return {
            name: requiredString(group.name, `navigation[${index}].name`),
            items: group.items.map((value, itemIndex) => {
                const item = asRecord(value, `navigation[${index}].items[${itemIndex}]`);
                assertKeys(item, NAVIGATION_ITEM_KEYS, `navigation[${index}].items[${itemIndex}]`);
                if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string')) throw new Error(`navigation[${index}].items[${itemIndex}].tags must be a string array`);
                const url = requiredString(item.url, `navigation[${index}].items[${itemIndex}].url`);
                if (!/^https:\/\//i.test(url)) throw new Error('navigation url must use https');
                return {
                    title: requiredString(item.title, `navigation[${index}].items[${itemIndex}].title`),
                    description: requiredString(item.description, `navigation[${index}].items[${itemIndex}].description`),
                    url,
                    tags: [...item.tags] as string[],
                };
            }),
        };
    });
    const resolved: PublicSiteSnapshot = {
        releaseId,
        site: { title: requiredString(site.title, 'site.title'), description: requiredString(site.description, 'site.description') },
        posts,
        navigation,
        ...(snapshot.redirects !== undefined ? { redirects: resolveRedirects(snapshot.redirects) } : {}),
        ...(snapshot.removedPaths !== undefined ? { removedPaths: resolveRemovedPaths(snapshot.removedPaths) } : {}),
    };
    assertSinglePathOwner(resolved);
    return resolved;
}

export function getStaticAssetUrl(releaseId: string, relativePath: string): string {
    const safeReleaseId = validateReleaseId(releaseId);
    const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid static asset path');
    return `/_site/${safeReleaseId}/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function getInlineScriptHashes(html: string): string[] {
    const hashes = new Set<string>();
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    for (const match of html.matchAll(scriptPattern)) {
        if (/\bsrc\s*=/.test(match[1])) continue;
        const script = match[2].replace(/\r\n?/g, '\n');
        if (!script.trim()) continue;
        hashes.add(`sha256-${createHash('sha256').update(script).digest('base64')}`);
    }
    return [...hashes].sort();
}

export function getPreviewNavigationHref(href: string, context: { releaseId: string; currentUrl: string }): string | null {
    const releaseId = validateReleaseId(context.releaseId);
    const current = new URL(context.currentUrl);
    const previewRelease = current.searchParams.get('previewRelease');
    if (!previewRelease) return href;
    if (previewRelease !== releaseId) return null;
    const target = new URL(href, current.origin);
    if (target.origin !== current.origin) return href;
    target.searchParams.set('previewRelease', releaseId);
    return `${target.pathname}${target.search}${target.hash}`;
}

function sha256(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex');
}

async function listFiles(root: string): Promise<string[]> {
    const output: string[] = [];
    async function visit(directory: string) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            if (entry.isSymbolicLink()) throw new Error(`Symbolic link is forbidden in static artifact: ${relative}`);
            if (entry.isDirectory()) await visit(absolute);
            else output.push(relative);
        }
    }
    await visit(root);
    return output.sort();
}

export async function createArtifactManifest(
    root: string,
    releaseId: string,
    excluded = new Set<string>(),
    candidateDigest = '',
    digestExcluded = new Set(['app/out/_release.json'])
): Promise<PublicArtifactManifest> {
    const files = [];
    for (const relative of await listFiles(root)) {
        if (excluded.has(relative)) continue;
        const lower = relative.toLowerCase();
        if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.map')) throw new Error(`Forbidden static artifact file: ${relative}`);
        if (/^(api|editor|setup)(\/|$)/i.test(relative)) throw new Error(`Backend route in public static artifact: ${relative}`);
        const content = await fs.readFile(path.join(root, relative));
        files.push({
            path: relative,
            size: content.byteLength,
            sha256: sha256(content),
            ...(relative.endsWith('.html') ? { inlineScriptHashes: getInlineScriptHashes(content.toString('utf8')) } : {}),
        });
    }
    const digestInput = files
        .filter((file) => !digestExcluded.has(file.path))
        .map((file) => `${file.path}\0${file.size}\0${file.sha256}`)
        .join('\n');
    return { version: 1, releaseId: validateReleaseId(releaseId), candidateDigest, files, artifactDigest: sha256(digestInput) };
}

export async function verifyArtifactTree(root: string): Promise<PublicArtifactManifest> {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'artifacts.json'), 'utf8')) as PublicArtifactManifest;
    const actual = await createArtifactManifest(
        root,
        manifest.releaseId,
        new Set(['artifacts.json']),
        manifest.candidateDigest
    );
    if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Artifact bytes do not match the sealed manifest');
    return actual;
}
