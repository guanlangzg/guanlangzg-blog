import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { listJobs } from '@/lib/jobs/store';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const { id } = await context.params;
    const job = (await listJobs()).find((item) => item.id === id);
    if (!job) return createEditorApiError('RESOURCE_NOT_FOUND', 404);
    return privateJson({
      id: job.id,
      type: job.type,
      status: job.status,
      attempt: job.attempt,
      nextAttemptAt: job.nextAttemptAt,
      remoteCommit: job.remoteCommit,
      error: job.lastError ? { message: '任务未能完成。' } : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
