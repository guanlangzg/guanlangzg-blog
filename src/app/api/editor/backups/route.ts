import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorSession, ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { enqueueCurrentGitHubBackup, listRemoteGitHubBackups } from '@/lib/github/backup-service';
import { readGitHubConnection } from '@/lib/github/config';

const DEFAULT_PAGE_SIZE = 20;

// §10.2: limit is clamped to 1..100 so a caller cannot request an unbounded page.
function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new TypeError('limit must be an integer between 1 and 100.');
  }
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);

    let limit: number;
    try {
      limit = parseLimit(request.nextUrl.searchParams.get('limit'));
    } catch {
      return createEditorApiError('INVALID_REQUEST', 400);
    }
    const cursor = request.nextUrl.searchParams.get('cursor');
    if (cursor !== null && !/^[1-9][0-9]*$/.test(cursor)) {
      return createEditorApiError('INVALID_REQUEST', 400);
    }
    const connection = await readGitHubConnection();
    if (!connection || connection.status !== 'connected') {
      return privateJson({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'not_connected' });
    }
    try {
      const remote = await listRemoteGitHubBackups({ cursor, limit });
      return privateJson({
        status: 'available',
        items: remote.items.map((item) => ({ ...item, source: 'remote' as const })),
        nextCursor: remote.nextCursor,
      });
    } catch {
      return privateJson({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'remote_error' });
    }
  } catch (error) {
    return mapEditorApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);
    await readJsonBodyWithLimit<unknown>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    const job = await enqueueCurrentGitHubBackup({ reason: 'manual' });
    const snapshotId = job.input && typeof job.input === 'object' && 'snapshotId' in job.input
      ? (job.input as { snapshotId?: unknown }).snapshotId
      : null;
    if (typeof snapshotId !== 'string') return mapEditorApiError(new Error('Backup job has no snapshot ID.'));
    return privateJson({ jobId: job.id, snapshotId }, 202);
  } catch (error) {
    return mapEditorApiError(error);
  }
}
