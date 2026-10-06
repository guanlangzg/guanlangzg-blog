import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { JsonBodyParseError, JsonBodyTooLargeError } from '@/lib/api-json-body';
import { EditorDataLockTimeoutError } from '@/lib/editor-data-storage';
import { BackupStateInvalidError } from '@/lib/jobs/watermark';
import { GitHubApiError } from '@/lib/github/client';
import { ArticleHistoryConflictError } from '@/lib/history/articles';
import { PublishingServiceError } from '@/lib/publishing/service';
import { ReleaseRetryError } from '@/lib/publishing/retry';
import { RestoreApplicationError } from '@/lib/restoring/apply';

export type EditorApiErrorCode =
  | 'INVALID_JSON'
  | 'AUTH_REQUIRED'
  | 'CSRF_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'STALE_RELEASE'
  | 'PUBLISH_IN_PROGRESS'
  | 'BODY_TOO_LARGE'
  | 'INVALID_SELECTION'
  | 'INVALID_BACKUP'
  | 'UNSUPPORTED_SCHEMA'
  | 'DATA_LOCK_TIMEOUT'
  | 'RATE_LIMITED'
  | 'GITHUB_NOT_READY'
  | 'BACKUP_REQUIRED'
  | 'INSUFFICIENT_STORAGE'
  | 'INTERNAL_ERROR'
  | 'INVALID_REQUEST';

export interface EditorApiFailureBody {
  error: {
    code: EditorApiErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

const DEFAULT_MESSAGES: Record<EditorApiErrorCode, string> = {
  INVALID_JSON: '请求 JSON 格式无效。',
  AUTH_REQUIRED: '请先登录管理后台。',
  CSRF_FAILED: '请求来源或 CSRF 校验失败。',
  RESOURCE_NOT_FOUND: '请求的资源不存在。',
  REVISION_CONFLICT: '数据已变化，请刷新后重试。',
  STALE_RELEASE: '候选发布已过期，请重新预览。',
  PUBLISH_IN_PROGRESS: '已有发布正在进行。',
  BODY_TOO_LARGE: '请求体超过允许大小。',
  INVALID_SELECTION: '恢复选择不完整或无效。',
  INVALID_BACKUP: '备份数据无效。',
  UNSUPPORTED_SCHEMA: '数据格式版本不受支持。',
  DATA_LOCK_TIMEOUT: '数据正在写入，请稍后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  GITHUB_NOT_READY: 'GitHub 连接尚未就绪。',
  BACKUP_REQUIRED: '需要有效且已追平的备份后才能继续。',
  INSUFFICIENT_STORAGE: '可用存储空间不足。',
  INTERNAL_ERROR: '服务器无法完成请求。',
  INVALID_REQUEST: '请求参数无效。',
};

function failure(
  status: number,
  code: EditorApiErrorCode,
  options: { message?: string; retryable?: boolean; requestId?: string } = {},
): NextResponse<EditorApiFailureBody> {
  const response = NextResponse.json({
    error: {
      code,
      message: options.message ?? DEFAULT_MESSAGES[code],
      retryable: options.retryable ?? false,
      requestId: options.requestId ?? randomUUID(),
    },
  }, { status });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export function createEditorApiError(
  code: EditorApiErrorCode,
  status: number,
  options: { message?: string; retryable?: boolean; requestId?: string } = {},
): NextResponse<EditorApiFailureBody> {
  return failure(status, code, options);
}

export function normalizeEditorApiResponse(response: Response): NextResponse {
  let code: EditorApiErrorCode = 'INTERNAL_ERROR';
  let status = response.status;
  if (status === 401) code = 'AUTH_REQUIRED';
  else if (status === 403) code = 'CSRF_FAILED';
  else if (status === 404) code = 'RESOURCE_NOT_FOUND';
  else if (status === 413) code = 'BODY_TOO_LARGE';
  else if (status === 400) code = 'INVALID_JSON';
  else if (status === 423) code = 'DATA_LOCK_TIMEOUT';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 507) code = 'INSUFFICIENT_STORAGE';
  else if (status < 400) {
    const next = new NextResponse(response.body, response);
    next.headers.set('Cache-Control', 'private, no-store');
    return next;
  }

  return failure(status, code, {
    message: code === 'INTERNAL_ERROR' ? undefined : DEFAULT_MESSAGES[code],
    retryable: status >= 500,
  });
}

export function mapEditorApiError(error: unknown): NextResponse<EditorApiFailureBody> {
  if (error instanceof JsonBodyTooLargeError) return failure(413, 'BODY_TOO_LARGE');
  if (error instanceof JsonBodyParseError) return failure(400, 'INVALID_JSON');
  if (error instanceof EditorDataLockTimeoutError) return failure(423, 'DATA_LOCK_TIMEOUT', { retryable: true });
  if (error instanceof BackupStateInvalidError) {
    return failure(503, 'INTERNAL_ERROR', {
      message: '服务器备份记账文件损坏，已暂停内容写入；请先修复运行时状态文件。',
      retryable: true,
    });
  }
  if (error instanceof RestoreApplicationError) {
    return failure(error.status, error.code, { retryable: error.status === 507 || error.status === 423 });
  }
  if (error instanceof PublishingServiceError) {
    const code: EditorApiErrorCode = error.code === 'RELEASE_STALE'
      ? 'STALE_RELEASE'
      : error.code === 'BACKUP_REQUIRED'
        ? 'BACKUP_REQUIRED'
        : error.code === 'RELEASE_CONFLICT' && /already publishing|another release/i.test(error.message)
          ? 'PUBLISH_IN_PROGRESS'
          : 'REVISION_CONFLICT';
    return failure(error.status, code, { retryable: false });
  }
  if (error instanceof ReleaseRetryError) {
    return failure(error.status, error.code === 'BACKUP_REQUIRED' ? 'BACKUP_REQUIRED' : 'REVISION_CONFLICT', { message: error.message });
  }
  if (error instanceof ArticleHistoryConflictError) return failure(409, 'REVISION_CONFLICT');
  if (error instanceof TypeError && /pagination|parameter|scope|articleId|expectedRevision|action/i.test(error.message)) {
    return failure(400, 'INVALID_REQUEST');
  }
  if (error instanceof GitHubApiError) {
    if (error.category === 'not_found') return failure(404, 'RESOURCE_NOT_FOUND');
    if (error.category === 'rate_limit') return failure(429, 'RATE_LIMITED', { retryable: true });
    if (error.category === 'unauthorized' || error.category === 'permission') return failure(503, 'GITHUB_NOT_READY');
    return failure(503, 'GITHUB_NOT_READY', { retryable: error.retryable });
  }
  if (error instanceof Error && error.name === 'UnsupportedSchemaError') return failure(422, 'UNSUPPORTED_SCHEMA');
  if (error instanceof Error && /unsupported_schema/i.test(error.message)) return failure(422, 'UNSUPPORTED_SCHEMA');
  if (error instanceof Error && /github.{0,60}(?:not configured|not ready|not set up|private key|connection|must be private)/i.test(error.message)) {
    return failure(503, 'GITHUB_NOT_READY');
  }
  if (error instanceof Error && /not found|does not exist|missing|invalid .* id/i.test(error.message)) return failure(404, 'RESOURCE_NOT_FOUND');
  if (error instanceof Error && /invalid|unsupported|does not match|must be/i.test(error.message)) return failure(422, 'INVALID_BACKUP');
  if (error instanceof Error && /ENOENT/.test((error as NodeJS.ErrnoException).code ?? '')) return failure(404, 'RESOURCE_NOT_FOUND');
  return failure(500, 'INTERNAL_ERROR', { retryable: true });
}

export function privateJson<T>(body: T, status = 200): NextResponse<T> {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
