import { NextRequest } from 'next/server';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { readGitHubConnection } from '@/lib/github/config';
import { createOrReuseActiveJob } from '@/lib/jobs/store';

export async function POST(request: NextRequest) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const connection = await readGitHubConnection();
    if (!connection || connection.status !== 'pending') {
      return createEditorApiError('GITHUB_NOT_READY', 409, { message: '请先保存待验证的 GitHub 配置。' });
    }

    const job = await createOrReuseActiveJob({
      type: 'github-check',
      input: { revision: connection.revision },
    });
    return privateJson({ jobId: job.id, status: job.status }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
