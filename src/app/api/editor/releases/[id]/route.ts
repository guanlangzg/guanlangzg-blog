import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { readRelease } from '@/lib/publishing/store';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const { id } = await context.params;
    const { release } = readRelease(id);
    return privateJson({
      id: release.id,
      scope: release.scope,
      baseLiveReleaseId: release.baseLiveReleaseId,
      selectedRevision: release.selectedRevision,
      candidateDigest: release.candidateDigest,
      artifactDigest: release.artifactDigest,
      status: release.status,
      hasBackupProof: release.backupProof !== null,
      publicCommitSha: release.publicCommitSha,
      workflowRunId: release.workflowRunId,
      workflowRunAttempt: release.workflowRunAttempt,
      retryFromAttempt: release.retryFromAttempt,
      error: release.error ? { code: release.error.code, retryable: release.error.retryable } : null,
      createdAt: release.createdAt,
      updatedAt: release.updatedAt,
    });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
