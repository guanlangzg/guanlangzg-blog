import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { readStoredRestorePlan, toRestorePlanDto } from '@/lib/editor-runtime/restore-plan-runtime';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);

    const { id } = await context.params;
    return privateJson(toRestorePlanDto(readStoredRestorePlan(id)));
  } catch (error) {
    return mapEditorApiError(error);
  }
}
