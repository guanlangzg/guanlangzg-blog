import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorSession, ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { createEditorPublishingService, listEditorReleases } from '@/lib/editor-runtime/adapters';
import { listJobs } from '@/lib/jobs/store';
import type { PublishScope } from '@/lib/publishing/types';

interface CreateReleaseBody {
  scope?: unknown;
  expectedRevision?: unknown;
}

const SCOPE_KINDS = new Set(['article', 'navigation', 'settings', 'bootstrap']);

function parseScope(value: unknown): PublishScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Release scope is required.');
  const scope = value as Record<string, unknown>;
  if (typeof scope.kind !== 'string' || !SCOPE_KINDS.has(scope.kind)) throw new TypeError('Release scope kind is invalid.');

  if (scope.kind === 'article') {
    if (typeof scope.articleId !== 'string' || !scope.articleId.trim()) throw new TypeError('articleId is required.');
    if (scope.action !== 'publish' && scope.action !== 'withdraw') throw new TypeError('action must be publish or withdraw.');
    return { kind: 'article', articleId: scope.articleId, action: scope.action };
  }

  if (scope.kind === 'bootstrap') {
    if (!Array.isArray(scope.articleIds) || scope.articleIds.some((id) => typeof id !== 'string')) {
      throw new TypeError('bootstrap articleIds must be a string array.');
    }
    return { kind: 'bootstrap', articleIds: scope.articleIds as string[] };
  }

  return scope.kind === 'navigation' ? { kind: 'navigation' } : { kind: 'settings' };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const jobs = await listJobs();
    const releases = listEditorReleases().map(({ id, scope, status, candidateDigest, artifactDigest, backupProof, publicCommitSha, workflowRunId, workflowRunAttempt, retryFromAttempt, error, createdAt, updatedAt }) => {
      const releaseJobs = jobs.filter((job) => job.type === 'publish'
        && (job.input as { releaseId?: unknown } | null)?.releaseId === id);
      const task = retryFromAttempt === null
        ? releaseJobs.find((job) => (job.input as { retry?: unknown } | null)?.retry !== true)
        : releaseJobs.find((job) => {
          const input = job.input as { retry?: unknown; retryFromAttempt?: unknown } | null;
          return input?.retry === true && input.retryFromAttempt === retryFromAttempt;
        }) ?? releaseJobs.find((job) => (job.input as { retry?: unknown } | null)?.retry !== true);
      return {
        id, scope, status, candidateDigest, artifactDigest, hasBackupProof: backupProof !== null,
        publicCommitSha, workflowRunId, workflowRunAttempt,
        error: error ? { code: error.code, retryable: error.retryable } : null,
        taskId: task?.id ?? null,
        createdAt, updatedAt,
      };
    });
    return privateJson({ releases });
  } catch (error) { return mapEditorApiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const body = await readJsonBodyWithLimit<CreateReleaseBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    const scope = parseScope(body?.scope);

    // Reject an obviously stale page before freezing anything; the authoritative
    // check against the stored revision still happens inside the service's lock.
    if (typeof body?.expectedRevision !== 'string' || !body.expectedRevision.trim()) {
      throw new TypeError('expectedRevision is required.');
    }

    const service = createEditorPublishingService();
    const { release } = await service.createCandidate(scope, body.expectedRevision);
    return privateJson({ releaseId: release.id, status: release.status }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
