import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { createGitHubArticleHistoryApi, restoreArticleHistoryVersion } from '@/lib/history/articles';
import { createPublishingGitHubRuntime } from '@/lib/editor-runtime/github-runtime';

interface HistoryRestoreBody {
  commitSha?: unknown;
}

/**
 * Restoring a historical version writes a NEW draft only. The remote branch head is never moved
 * and no publish is queued, so the public site stays untouched until a separate release is made.
 * The default draft writer is revision-checked, so a concurrent edit raises a conflict instead of
 * being overwritten.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    const body = await readJsonBodyWithLimit<HistoryRestoreBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    if (typeof body?.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.commitSha.trim())) {
      throw new TypeError('commitSha must be a full commit SHA.');
    }

    const runtime = await createPublishingGitHubRuntime();
    if (!runtime) return createEditorApiError('GITHUB_NOT_READY', 503, { retryable: true });

    const article = await restoreArticleHistoryVersion(
      createGitHubArticleHistoryApi(runtime.readHistoryApiOptions()),
      { articleId: id, commitSha: body.commitSha.trim() },
    );

    return privateJson({ articleId: article.id, status: article.status }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
