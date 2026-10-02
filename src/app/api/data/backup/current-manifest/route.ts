import { NextRequest, NextResponse } from 'next/server';
import {
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    createCurrentEditorBackupRestorePreconditionReference,
} from '@/lib/editor-data-backup';
import {
    withEditorDataRootLock,
} from '@/lib/editor-data-storage';

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    try {
        return NextResponse.json({
            ...(await withEditorDataRootLock(() => createCurrentEditorBackupRestorePreconditionReference())),
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const lockTimeoutResponse = createEditorDataLockTimeoutResponse(error);

        if (lockTimeoutResponse) {
            return lockTimeoutResponse;
        }

        const invalidResponse = createEditorDataFileInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}
