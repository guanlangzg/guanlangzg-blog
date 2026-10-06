import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { isLiveReaderRuntime, readVerifiedLiveSnapshot } from '@/lib/live-public-reader';
import {
    EditorMediaPathInvalidError,
    resolvePublicMediaFilePath,
} from '@/lib/editor-media-storage';

function getContentType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.png') {
        return 'image/png';
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        return 'image/jpeg';
    }

    if (extension === '.webp') {
        return 'image/webp';
    }

    if (extension === '.gif') {
        return 'image/gif';
    }

    return 'application/octet-stream';
}

const MANAGED_MEDIA_FILE_NAME_PATTERN = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/;
const MEDIA_MIME_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/**
 * Anonymous reads are limited to managed media referenced by the verified live release. The working
 * manifest is deliberately not consulted: a restore or a manual edit can drop an entry while the
 * published bytes are still on disk, and refusing those is a false rejection. Identity instead comes
 * from the frozen digest plus the content-addressed file name, and the bytes are re-hashed below
 * before they leave.
 */
function readLivePublicMediaIdentity(mediaPath: string): { sha256: string; size: number } | null {
    if (!isLiveReaderRuntime()) return null;
    const media = readVerifiedLiveSnapshot()?.snapshot.media.find((item) => item.originalPath === mediaPath);
    if (!media) return null;
    const expectedExtension = MEDIA_MIME_EXTENSIONS[media.mimeType];
    const fileName = mediaPath.split('/').at(-1) ?? '';
    const nameMatch = MANAGED_MEDIA_FILE_NAME_PATTERN.exec(fileName);
    if (!expectedExtension || !nameMatch || nameMatch[1] !== media.sha256 || nameMatch[2] !== expectedExtension) {
        return null;
    }
    return { sha256: media.sha256, size: media.size };
}

function matchesFrozenMediaBytes(
    bytes: Uint8Array,
    identity: { sha256: string; size: number },
): boolean {
    return bytes.byteLength === identity.size
        && createHash('sha256').update(bytes).digest('hex') === identity.sha256;
}

export async function GET(
    request: NextRequest,
    context: { params: Promise<{ path: string[] }> }
) {
    const params = await context.params;
    const mediaPath = params.path.join('/');
    const sessionCookie = request.cookies.get(EDITOR_SESSION_COOKIE)?.value;
    const anonymousIdentity = sessionCookie ? null : readLivePublicMediaIdentity(mediaPath);
    if (!sessionCookie) {
        if (!anonymousIdentity) {
            return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }
    } else {
        const authError = await ensureEditorSession(request);
        if (authError) return authError;
    }

    try {
        const filePath = resolvePublicMediaFilePath(mediaPath);
        const file = await fsPromises.readFile(filePath);

        // The content-addressed path and the manifest can be rewritten together, so an anonymous
        // response must re-verify the bytes against the frozen live snapshot before they leave.
        if (anonymousIdentity && !matchesFrozenMediaBytes(file, anonymousIdentity)) {
            return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }

        const isPublic = !sessionCookie;

        return new Response(file, {
            headers: {
                'Content-Type': getContentType(filePath),
                'Cache-Control': isPublic ? 'public, max-age=300, stale-while-revalidate=600' : 'private, no-store',
                ...(isPublic ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }),
            },
        });
    } catch (error) {
        if (
            error instanceof EditorMediaPathInvalidError ||
            (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
            return new Response('Not found', { status: 404 });
        }

        throw error;
    }
}
