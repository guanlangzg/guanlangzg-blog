export const PREVIEW_RELEASE_PARAM = 'previewRelease';

const RELEASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Brand files the public shell and the login page may load before a session exists. */
const ANONYMOUS_BRAND_ASSETS = new Set([
    '/favicon.ico',
    '/favicon-16.png',
    '/favicon-32.png',
    '/favicon-48.png',
    '/favicon-64.png',
    '/guanlan-logo.png',
]);

/** Public entry points that are files or data, so a browser redirect would be useless. */
const PUBLIC_RESOURCE_PATHS = new Set([
    'feed.xml',
    'llms.txt',
    'manifest.webmanifest',
    'og',
    'robots.txt',
    'search-index.json',
    'sitemap.xml',
]);

/**
 * Reader routes the VPS serves anonymously. This keeps the original single-host behaviour: the
 * public blog and the editor share one origin, and readers open the editor through the `:admin`
 * command in the header search instead of a separate admin host. Only paths the dynamic app
 * actually renders are listed, so static-only routes stay behind the login page.
 */
const PUBLIC_READER_DOCUMENT_PATHS = new Set(['/', '/blog', '/navigation']);
const PUBLIC_READER_DOCUMENT_PREFIXES = ['/blog/', '/posts/', '/navigation/'];
const PUBLIC_READER_RESOURCE_PATHS = new Set(['/feed.xml', '/sitemap.xml', '/robots.txt', '/og']);
const MANAGED_PUBLIC_MEDIA_PATH = /^\/media\/files\/(?:[a-zA-Z0-9_-]+\/)*[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/i;

function isPublicReaderPath(pathname: string): boolean {
    if (PUBLIC_READER_DOCUMENT_PATHS.has(pathname)) return true;
    if (PUBLIC_READER_DOCUMENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
    return PUBLIC_READER_RESOURCE_PATHS.has(pathname);
}

export type VpsRequestDecision =
    | { kind: 'allow' }
    | { kind: 'editor' }
    | { kind: 'preview'; releaseId: string; artifactPath: string }
    | { kind: 'blocked'; target: 'document' | 'resource' };

export interface VpsRequestInput {
    pathname: string;
    previewRelease: string | null;
    isRscRequest: boolean;
}

function isSafeEncodedPath(pathname: string): boolean {
    if (pathname.includes('\\') || /%(?:2f|5c)/i.test(pathname)) return false;
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return false;
    }
    if (decoded.includes('\\')) return false;
    return !decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

function isDocumentPath(segments: string[]): boolean {
    const last = segments[segments.length - 1] ?? '';
    if (segments[0] === 'media') return false;
    if (PUBLIC_RESOURCE_PATHS.has(segments.join('/').toLowerCase())) return false;
    return !last.includes('.');
}

/** Sealed artifacts are directory indexes, so a document path needs its index file appended. */
function resolveArtifactPath(segments: string[], isDocument: boolean, isRscRequest: boolean): string {
    const base = segments.join('/');
    if (!isDocument) return base;
    const indexFile = isRscRequest ? 'index.txt' : 'index.html';
    return base ? `${base}/${indexFile}` : indexFile;
}

/**
 * Single source of truth for what the VPS may serve. The login page, setup, management assets,
 * brand files and the reader site are anonymous; any other content path must resolve to a sealed
 * artifact of an explicitly named release, never to the live working copy. The reader pages are
 * rendered dynamically from the working copy but only ever expose non-draft articles.
 */
export function classifyVpsRequest(input: VpsRequestInput): VpsRequestDecision {
    const { pathname } = input;

    if (pathname === '/editor/login' || pathname.startsWith('/editor/login/')) return { kind: 'allow' };
    if (pathname === '/setup' || pathname.startsWith('/setup/')) return { kind: 'allow' };
    if (pathname === '/api' || pathname.startsWith('/api/')) return { kind: 'allow' };
    if (pathname.startsWith('/_next/')) return { kind: 'allow' };
    if (ANONYMOUS_BRAND_ASSETS.has(pathname)) return { kind: 'allow' };
    if (pathname === '/editor' || pathname.startsWith('/editor/')) return { kind: 'editor' };

    const releaseBound = pathname === '/_site' || pathname.startsWith('/_site/');

    if (!isSafeEncodedPath(pathname)) {
        return { kind: 'blocked', target: releaseBound ? 'resource' : 'document' };
    }

    const segments = pathname.split('/').filter(Boolean);

    if (releaseBound) {
        const releaseId = segments[1] ?? '';
        const hasAssetPath = segments.length > 2;
        if (!RELEASE_ID_PATTERN.test(releaseId) || !hasAssetPath) return { kind: 'blocked', target: 'resource' };
        if (input.previewRelease !== null && input.previewRelease !== releaseId) {
            return { kind: 'blocked', target: 'resource' };
        }
        return { kind: 'preview', releaseId, artifactPath: segments.join('/') };
    }

    const isManagedMedia = MANAGED_PUBLIC_MEDIA_PATH.test(pathname);
    const isDocument = isDocumentPath(segments);
    // A redirect only helps a real browser navigation: RSC payload and prefetch requests
    // for the same route must fail closed instead of following a login redirect.
    const target: 'document' | 'resource' = isDocument && !input.isRscRequest ? 'document' : 'resource';

    if (input.previewRelease === null) {
        // Without a named release the media route serves managed media only after checking the
        // bytes against the verified live snapshot, so this URL stays on the dynamic app.
        if (isManagedMedia) return { kind: 'allow' };
        return isPublicReaderPath(pathname) ? { kind: 'allow' } : { kind: 'blocked', target };
    }
    if (!RELEASE_ID_PATTERN.test(input.previewRelease)) return { kind: 'blocked', target };

    return {
        kind: 'preview',
        releaseId: input.previewRelease,
        // Sealed media lives under _site/<releaseId>/media/..., so a named preview must read the
        // frozen bytes of that release instead of the working copy behind the bare /media/... URL.
        artifactPath: isManagedMedia
            ? `_site/${input.previewRelease}/${segments.join('/')}`
            : resolveArtifactPath(segments, isDocument, input.isRscRequest),
    };
}
