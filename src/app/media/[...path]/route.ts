import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
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

/**
 * Legacy admin media path. It reads the live working copy, so it is management-only: an
 * anonymous request must never reach stored bytes, and responses stay privately cached so a
 * shared proxy cannot retain an unpublished image.
 */
export async function GET(
    request: NextRequest,
    context: { params: Promise<{ path: string[] }> }
) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    const params = await context.params;
    const mediaPath = params.path.join('/');

    try {
        const filePath = resolvePublicMediaFilePath(mediaPath);
        const file = await fsPromises.readFile(filePath);

        return new Response(file, {
            headers: {
                'Content-Type': getContentType(filePath),
                'Cache-Control': 'private, no-store',
                'X-Robots-Tag': 'noindex, nofollow',
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
