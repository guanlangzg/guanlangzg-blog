import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { listArticleHistory, createGitHubArticleHistoryApi } from '@/lib/history/articles';
import { readGitHubConnection } from '@/lib/github/config';
import { GitHubAppTokenManager } from '@/lib/github/app';

type HistoryParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: HistoryParams) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const { id } = await context.params;
    const url = new URL(request.url);
    const cursorValue = url.searchParams.get('cursor');
    const limitValue = url.searchParams.get('limit');
    const page = cursorValue === null ? 1 : Number(cursorValue);
    const perPage = limitValue === null ? 20 : Number(limitValue);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) {
      return createEditorApiError('INVALID_REQUEST', 400, { message: '文章历史分页参数无效。' });
    }
    const connection = await readGitHubConnection();
    if (!connection || connection.status !== 'connected') return createEditorApiError('GITHUB_NOT_READY', 503);
    const api = createGitHubArticleHistoryApi({
      repository: connection.repos.backup,
      tokenProvider: new GitHubAppTokenManager({
        appId: connection.appId,
        installationId: connection.installationId,
        repositories: connection.repos,
      }),
    });
    const history = await listArticleHistory(api, id, { page, perPage });
    return privateJson({
      articleId: history.articleId,
      items: history.versions.map((version) => ({
        commitSha: version.commitSha,
        message: version.message,
        committedAt: version.committedAt,
        title: version.article.title,
        slug: version.article.slug ?? null,
        updatedAt: version.article.updatedAt,
        summary: version.summary,
      })),
      nextCursor: history.nextPage === null ? null : String(history.nextPage),
    });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
