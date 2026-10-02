import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { createEditorPublishingService } from '@/lib/editor-runtime/adapters';

interface ConfirmationBody {
  candidateDigest?: unknown;
  artifactDigest?: unknown;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    const body = await readJsonBodyWithLimit<ConfirmationBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    if (typeof body?.candidateDigest !== 'string' || typeof body?.artifactDigest !== 'string') {
      throw new TypeError('candidateDigest and artifactDigest are required.');
    }

    // The service re-checks selected content, live baseline, media hashes, sealed artifact
    // identity and the global backup gate inside one short content lock, and returns the
    // existing task for a repeated confirmation instead of creating a second one.
    const service = createEditorPublishingService();
    const task = await service.confirm(id, {
      candidateDigest: body.candidateDigest,
      artifactDigest: body.artifactDigest,
    });
    return privateJson({ taskId: task.id, releaseId: task.releaseId, status: task.status }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
