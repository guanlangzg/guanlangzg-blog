import { NextRequest, NextResponse } from 'next/server';
import {
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    createRemoteBackupRestoreResponse,
    createRemoteBackupStatusResponse,
    createRemoteBackupSyncResponse,
    parseRemoteBackupAction,
    readRemoteBackupRequestBody,
} from './actions';

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    return createRemoteBackupStatusResponse();
}

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    const { body, response } = await readRemoteBackupRequestBody(request);

    if (response) {
        return response;
    }

    const action = parseRemoteBackupAction(body?.action);

    if (!action) {
        return NextResponse.json(
            {
                message: '远端备份操作无效。',
            },
            { status: 400 }
        );
    }

    if (action === 'sync') {
        return createRemoteBackupSyncResponse();
    }

    return createRemoteBackupRestoreResponse(body?.currentManifest);
}
