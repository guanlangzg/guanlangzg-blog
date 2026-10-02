import { NextRequest } from 'next/server';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { createEditorReleaseRetryService } from '@/lib/editor-runtime/retry-runtime';

/**
 * Retries a determined deployment failure by rerunning the SAME workflow run and verifying the
 * NEW attempt. The request carries no identifiers: run id, attempt and artifact all come from
 * persisted state, so a caller cannot retarget the retry at another commit or rebuild.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    let service;
    try {
      service = await createEditorReleaseRetryService();
    } catch {
      // No GitHub connection means the deployment cannot be reconciled: report a clear
      // blocker and leave the release untouched instead of pretending a retry started.
      return createEditorApiError('GITHUB_NOT_READY', 503, { retryable: true });
    }

    const task = await service.retry(id);
    return privateJson({ taskId: task.id, releaseId: task.releaseId, status: task.status }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
