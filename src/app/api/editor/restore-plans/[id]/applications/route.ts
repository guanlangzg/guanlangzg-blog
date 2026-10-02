import { NextRequest } from 'next/server';
import { EDITOR_JSON_BODY_LIMIT_BYTES, readJsonBodyWithLimit } from '@/lib/api-json-body';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { applyStoredRestorePlan, readStoredRestorePlan } from '@/lib/editor-runtime/restore-plan-runtime';
import { RestoreApplicationError } from '@/lib/restoring/apply';
import type { RestoreChoice } from '@/lib/restoring/apply';
import type { RestoreResolution } from '@/lib/restoring/plan';

interface ApplicationBody {
  baseRevision?: unknown;
  choices?: unknown;
}

const RESOLUTIONS = new Set<RestoreResolution>(['keep-current', 'use-backup', 'keep-both']);

function parseChoices(value: unknown): RestoreChoice[] {
  if (!Array.isArray(value)) throw new TypeError('choices must be an array.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Each choice must be an object.');
    const choice = item as Record<string, unknown>;
    if (typeof choice.conflictId !== 'string' || !choice.conflictId.trim()) throw new TypeError('conflictId is required.');
    if (typeof choice.resolution !== 'string' || !RESOLUTIONS.has(choice.resolution as RestoreResolution)) {
      throw new TypeError('resolution must be keep-current, use-backup or keep-both.');
    }
    return { conflictId: choice.conflictId, resolution: choice.resolution as RestoreResolution };
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    const body = await readJsonBodyWithLimit<ApplicationBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    if (typeof body?.baseRevision !== 'string' || !body.baseRevision.trim()) {
      throw new TypeError('baseRevision is required.');
    }

    const plan = readStoredRestorePlan(id);
    if (body.baseRevision !== plan.binding.currentRevision) {
      throw new RestoreApplicationError(409, 'REVISION_CONFLICT', '恢复计划基线已变化，请重新生成计划。');
    }
    const choices = parseChoices(body.choices);
    if (plan.conflicts.some((conflict) => !choices.some((choice) => choice.conflictId === conflict.conflictId))) {
      throw new RestoreApplicationError(422, 'INVALID_SELECTION', '尚未选择全部恢复冲突。');
    }
    const result = await applyStoredRestorePlan(id, body.baseRevision, choices);
    return privateJson({ generation: result.generation });
  } catch (error) {
    return mapEditorApiError(error);
  }
}
