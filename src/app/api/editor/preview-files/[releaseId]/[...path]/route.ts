import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse } from '@/lib/editor-api-errors';
import { servePreviewArtifact } from '@/lib/public-build/preview';
import { readActivePreviewReleaseId } from '@/lib/editor-runtime/preview-session';
import { findSealedArtifactRoot } from '@/lib/editor-runtime/adapters';

const SAFE_RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Every artifact request (HTML, JS, media, search index, RSC/prefetch) goes through this
 * handler. The caller's session, the path release ID, the activated preview release and the
 * URL previewRelease parameter must all agree, so an old tab can never read a new candidate.
 */
async function servePreviewRequest(
  request: NextRequest,
  context: { params: Promise<{ releaseId: string; path?: string[] }> }
) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { releaseId, path: pathSegments } = await context.params;
    if (!SAFE_RELEASE_ID.test(releaseId)) return mapEditorApiError(Object.assign(new Error('Artifact not found.'), { code: 'ENOENT' }));

    const releaseRoot = findSealedArtifactRoot(releaseId);
    if (!releaseRoot) return mapEditorApiError(Object.assign(new Error('Artifact not found.'), { code: 'ENOENT' }));

    const response = await servePreviewArtifact({
      authorized: true,
      requestedReleaseId: releaseId,
      expectedReleaseId: releaseId,
      activeReleaseId: readActivePreviewReleaseId(),
      previewRelease: request.nextUrl.searchParams.get('previewRelease'),
      relativePath: (pathSegments ?? []).join('/'),
      method: request.method,
      releaseRoot,
    });
    return response;
  } catch (error) {
    return mapEditorApiError(error);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ releaseId: string; path?: string[] }> }) {
  return servePreviewRequest(request, context);
}

/** Prefetch and RSC navigation issue HEAD requests, which must obey the same fixed identity. */
export async function HEAD(request: NextRequest, context: { params: Promise<{ releaseId: string; path?: string[] }> }) {
  return servePreviewRequest(request, context);
}
