import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PublicArtifactManifest, PublicArtifactFile } from '@/public-site/types';

export interface PreviewArtifactRequest {
    authorized: boolean;
    requestedReleaseId: string;
    expectedReleaseId: string;
    activeReleaseId: string | null;
    previewRelease: string | null;
    relativePath: string;
    method: string;
    releaseRoot: string;
}

const CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
};

function response(status: number, body: string | null, extraHeaders?: HeadersInit): Response {
    const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
    });
    for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
    return new Response(body, { status, headers });
}

function resolveManifestEntry(pathname: string, files: PublicArtifactFile[]): PublicArtifactFile | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (decoded.includes('\\') || decoded.startsWith('/') || decoded.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    if (/%(?:2f|5c)/i.test(decoded)) return null;
    const candidates = [decoded, `app/out/${decoded}`];
    return files.find((file) => candidates.includes(file.path)) || null;
}

function createPageCsp(hashes: string[]): string {
    const scriptPolicy = hashes.length ? hashes.map((hash) => `'${hash}'`).join(' ') : "'self'";
    return [
        "default-src 'self'",
        `script-src 'self' ${scriptPolicy}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ].join('; ');
}

export async function servePreviewArtifact(input: PreviewArtifactRequest): Promise<Response> {
    if (!input.authorized) return response(401, 'Unauthorized');
    if (input.method !== 'GET' && input.method !== 'HEAD') return response(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.requestedReleaseId)) return response(404, 'Not Found');
    const fixedIdentity = input.requestedReleaseId === input.expectedReleaseId &&
        input.requestedReleaseId === input.activeReleaseId &&
        input.previewRelease === input.requestedReleaseId;
    if (!fixedIdentity) return response(409, 'Preview release expired');

    let manifest: PublicArtifactManifest;
    try {
        manifest = JSON.parse(await fs.readFile(path.join(input.releaseRoot, 'artifacts.json'), 'utf8')) as PublicArtifactManifest;
    } catch {
        return response(404, 'Not Found');
    }
    if (manifest.version !== 1 || manifest.releaseId !== input.requestedReleaseId || !Array.isArray(manifest.files)) return response(404, 'Not Found');
    const entry = resolveManifestEntry(input.relativePath, manifest.files);
    if (!entry || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) return response(404, 'Not Found');
    const artifactRoot = path.resolve(input.releaseRoot, 'app', 'out');
    const relative = entry.path.startsWith('app/out/') ? entry.path.slice('app/out/'.length) : entry.path;
    const filePath = path.resolve(artifactRoot, ...relative.split('/'));
    const fromArtifactRoot = path.relative(artifactRoot, filePath);
    if (!fromArtifactRoot || fromArtifactRoot.startsWith('..') || path.isAbsolute(fromArtifactRoot)) return response(404, 'Not Found');

    try {
        let current = artifactRoot;
        for (const segment of relative.split('/')) {
            current = path.join(current, segment);
            const info = await fs.lstat(current);
            if (info.isSymbolicLink()) return response(404, 'Not Found');
            if (current !== filePath && !info.isDirectory()) return response(404, 'Not Found');
        }
        const content = await fs.readFile(filePath);
        if (content.byteLength !== entry.size || createHash('sha256').update(content).digest('hex') !== entry.sha256) return response(409, 'Preview artifact integrity check failed');
        const extension = path.extname(filePath).toLowerCase();
        const headers = new Headers({ 'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream' });
        if (extension === '.html') headers.set('Content-Security-Policy', createPageCsp(entry.inlineScriptHashes || []));
        if (input.method === 'HEAD') return response(200, null, headers);
        return new Response(content, {
            status: 200,
            headers: {
                ...Object.fromEntries(headers.entries()),
                'Cache-Control': 'private, no-store',
                'X-Robots-Tag': 'noindex, nofollow',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return response(404, 'Not Found');
        throw error;
    }
}
