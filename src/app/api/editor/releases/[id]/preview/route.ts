import { NextRequest } from 'next/server';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { activatePreviewRelease } from '@/lib/editor-runtime/preview-session';
import { readSealedArtifactIdentity } from '@/lib/editor-runtime/adapters';

/**
 * Activating a preview is a POST so a link cannot change what an admin sees, and only
 * a release with a sealed, verified artifact may become the active preview.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    const identity = readSealedArtifactIdentity(id);
    if (!identity) return mapEditorApiError(new Error('Release artifact not found.'));

    activatePreviewRelease(id);
    return privateJson({ entry: `/?previewRelease=${encodeURIComponent(id)}`, releaseId: id });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
