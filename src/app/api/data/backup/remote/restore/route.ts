import { NextRequest } from 'next/server';
import {
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import {
    createRemoteBackupRestoreResponse,
    readRemoteBackupRequestBody,
} from '../actions';

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    const { body, response } = await readRemoteBackupRequestBody(request);

    if (response) {
        return response;
    }

    return createRemoteBackupRestoreResponse(body?.currentManifest);
}
