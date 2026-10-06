import { NextRequest, NextResponse } from 'next/server';
import {
    createEditorBackupStateInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import { deleteOrphanMediaFiles } from '@/lib/editor-media-storage';
import { recordEditorAuditEvent } from '@/lib/editor-audit-log';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    try {
        // The data-root lock keeps GC from running between a media write and its
        // manifest update (or during a restore's directory swap), where manifest
        // and disk disagree and fresh files would be misjudged as orphans.
        const result = await withRuntimeDataRootLock(() => deleteOrphanMediaFiles());

        recordEditorAuditEvent({
            action: 'media.gc',
            resource: 'media',
            outcome: 'success',
            metadata: {
                deleted: result.deleted,
                freedBytes: result.freedBytes,
            },
        });

        return NextResponse.json({
            success: true,
            ...result,
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const backupStateResponse = createEditorBackupStateInvalidResponse(error);

        if (backupStateResponse) {
            return backupStateResponse;
        }

        const lockTimeoutResponse = createEditorDataLockTimeoutResponse(error);

        if (lockTimeoutResponse) {
            return lockTimeoutResponse;
        }

        throw error;
    }
}
