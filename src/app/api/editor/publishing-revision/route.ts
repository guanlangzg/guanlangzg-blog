import { NextRequest } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { readDraftResourceRevisions, readDraftSnapshot } from '@/lib/editor-runtime/adapters';

export async function GET(request: NextRequest) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const revisions = readDraftResourceRevisions(readDraftSnapshot());
    return privateJson({
      revisions: {
        article: revisions.article || null,
        navigation: revisions.navigation || null,
        settings: revisions.settings || null,
        bootstrap: revisions.bootstrap || null,
      },
    });
  } catch (error) { return mapEditorApiError(error); }
}
