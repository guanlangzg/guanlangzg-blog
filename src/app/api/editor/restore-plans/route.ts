import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { createStoredRestorePlan } from '@/lib/editor-runtime/restore-plan-runtime';

interface RestorePlanBody {
  backupCommit?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const body = await readJsonBodyWithLimit<RestorePlanBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    if (typeof body?.backupCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(body.backupCommit.trim())) {
      throw new TypeError('backupCommit must be a full commit SHA.');
    }

    const { plan, planId } = await createStoredRestorePlan(body.backupCommit.trim());
    return privateJson({ planId, conflictCount: plan.conflicts.length });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
