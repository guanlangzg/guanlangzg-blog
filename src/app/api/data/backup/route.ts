import { NextRequest, NextResponse } from 'next/server';
import {
    EDITOR_BACKUP_JSON_BODY_LIMIT_BYTES,
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    createEditorBackupInvalidResponse,
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    createCurrentEditorBackupPayload,
    restoreEditorBackupPayload,
} from '@/lib/editor-data-backup';
import {
    getRemoteBackupQueueSnapshot,
    queueCurrentBackupToRemote,
    shouldQueueRemoteBackupRetry,
    syncCurrentBackupToRemote,
} from '@/lib/editor-remote-backup';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import {
    createRestoreConflictResponse,
    createRestorePreconditionRequiredResponse,
    parseRestoreCurrentManifest,
} from './restore-precondition';

type BackupRequestBody = {
    articles?: unknown;
    navigation?: unknown;
    settings?: unknown;
    media?: unknown;
    currentManifest?: unknown;
    data?: {
        articles?: unknown;
        navigation?: unknown;
        settings?: unknown;
        media?: unknown;
    };
};

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    try {
        return NextResponse.json(await createCurrentEditorBackupPayload({
            includeInlineMediaFiles: true,
        }));
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

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    let body: BackupRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<BackupRequestBody>(request, EDITOR_BACKUP_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    const currentManifest = parseRestoreCurrentManifest(body?.currentManifest);

    if (!currentManifest) {
        return createRestorePreconditionRequiredResponse();
    }

    let result;

    try {
        result = await restoreEditorBackupPayload(body, {
            currentManifest,
            requireInlineMediaFiles: true,
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

        const backupInvalidResponse = createEditorBackupInvalidResponse(error);

        if (backupInvalidResponse) {
            return backupInvalidResponse;
        }

        const conflictResponse = createRestoreConflictResponse(error);

        if (conflictResponse) {
            return conflictResponse;
        }

        throw error;
    }

    const remoteBackup = await syncCurrentBackupToRemote({
        reason: 'local-restore',
        writeSnapshot: true,
    });
    if (shouldQueueRemoteBackupRetry(remoteBackup)) {
        await queueCurrentBackupToRemote({
            reason: 'local-restore',
            writeSnapshot: true,
        });
    }
    invalidatePublicContentCache('local-restore');
    const queueSnapshot = await getRemoteBackupQueueSnapshot();

    return NextResponse.json({
        success: true,
        counts: {
            articles: result.articles,
            categories: result.categories,
            settings: result.settings,
            media: result.media,
        },
        remoteBackup,
        ...queueSnapshot,
    });
}
