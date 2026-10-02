import { NextRequest } from 'next/server';
import {
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import { createRemoteBackupSyncResponse } from '../actions';

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    return createRemoteBackupSyncResponse();
}
