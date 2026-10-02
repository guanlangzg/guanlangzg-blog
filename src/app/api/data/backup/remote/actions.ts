import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    createEditorBackupInvalidResponse,
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
} from '@/lib/editor-api-auth';
import {
    assertEditorBackupRestoreCurrentManifest,
    parseEditorBackupDataOrThrow,
    restoreEditorBackupData,
} from '@/lib/editor-data-backup';
import {
    EditorMediaRestoreDownloadError,
    materializeEditorMediaRestoreDataFromR2,
} from '@/lib/editor-media-remote';
import {
    getRemoteBackupQueueSnapshot,
    queueCurrentBackupToRemote,
    retryFailedRemoteBackups,
    shouldQueueRemoteBackupRetry,
    syncCurrentBackupToRemote,
} from '@/lib/editor-remote-backup';
import {
    downloadLatestBackupPayloadFromR2,
    getR2BackupStatus,
    R2BackupNotConfiguredError,
    R2BackupPayloadTooLargeError,
    R2BackupSettingsInvalidError,
} from '@/lib/r2-backup-storage';
import {
    materializeLatestChunkedBackupFromR2,
    R2ChunkedBackupFormatError,
    R2ChunkedBackupIntegrityError,
    R2ChunkedBackupNotFoundError,
    R2ChunkedBackupObjectMissingError,
} from '@/lib/r2-chunked-backup-storage';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import {
    createRestoreConflictResponse,
    createRestorePreconditionRequiredResponse,
    parseRestoreCurrentManifest,
} from '../restore-precondition';

export type RemoteBackupAction = 'sync' | 'restore';

export type RemoteBackupRequestBody = {
    action?: unknown;
    currentManifest?: unknown;
};

export function parseRemoteBackupAction(value: unknown): RemoteBackupAction | null {
    return value === 'sync' || value === 'restore' ? value : null;
}

function getRemoteRestoreErrorMessage(error: unknown): string {
    if (
        error instanceof R2ChunkedBackupFormatError ||
        error instanceof R2ChunkedBackupIntegrityError ||
        error instanceof R2ChunkedBackupObjectMissingError
    ) {
        return error.message;
    }

    if (error instanceof R2BackupSettingsInvalidError) {
        return '远端备份配置无效。';
    }

    if (error instanceof R2BackupPayloadTooLargeError) {
        return '备份数据超出大小限制。';
    }

    if (error instanceof R2BackupNotConfiguredError) {
        return '远端备份未配置。';
    }

    if (error instanceof Error && error.message === 'Latest R2 backup is not valid JSON.') {
        return 'R2 最新备份不是合法 JSON，恢复失败。';
    }

    if (
        error instanceof Error &&
        error.message.startsWith('Latest R2 backup was not found at ')
    ) {
        return 'R2 最新备份不存在，恢复失败。';
    }

    return error instanceof Error && error.message
        ? error.message
        : '远端备份操作失败，请检查配置后重试。';
}

async function materializeLatestRemoteBackupData() {
    try {
        const chunked = await materializeLatestChunkedBackupFromR2();

        return {
            format: chunked.format,
            data: chunked.data,
            mediaRestore: chunked.mediaRestore,
        };
    } catch (error) {
        if (!(error instanceof R2ChunkedBackupNotFoundError)) {
            throw error;
        }
    }

    const payload = await downloadLatestBackupPayloadFromR2();
    const data = parseEditorBackupDataOrThrow(payload);
    const mediaRestore = await materializeEditorMediaRestoreDataFromR2(data.media?.manifest);

    return {
        format: 'v1-full-json' as const,
        data: {
            ...data,
            ...(mediaRestore.media ? { media: mediaRestore.media } : {}),
        },
        mediaRestore: mediaRestore.result,
    };
}

async function createRemoteBackupFailureResponse(
    remoteBackup: Awaited<ReturnType<typeof syncCurrentBackupToRemote>>
): Promise<NextResponse> {
    if (remoteBackup.success) {
        throw new Error('Expected failed remote backup result.');
    }

    const queueSnapshot = await getRemoteBackupQueueSnapshot();

    return NextResponse.json(
        {
            message: remoteBackup.message,
            remoteBackup,
            ...queueSnapshot,
        },
        {
            status: 'runtimeDataUnavailable' in remoteBackup && remoteBackup.runtimeDataUnavailable
                ? 503
                : 'invalidConfiguration' in remoteBackup && remoteBackup.invalidConfiguration
                    ? 500
                    : 502,
        }
    );
}

function createRemoteBackupPayloadTooLargeResponse(error: R2BackupPayloadTooLargeError): NextResponse {
    return NextResponse.json(
        {
            code: 'remote_backup_too_large',
            message: `R2 远端备份文件超过 ${error.limitBytes} 字节，恢复失败。`,
        },
        { status: 413 }
    );
}

function createInvalidR2SettingsResponse(error: unknown): NextResponse | null {
    if (!(error instanceof R2BackupSettingsInvalidError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
        },
        { status: 500 }
    );
}

export async function readRemoteBackupRequestBody(
    request: NextRequest
): Promise<{ body: RemoteBackupRequestBody | null; response: null } | { body: null; response: NextResponse }> {
    try {
        return {
            body: await readJsonBodyWithLimit<RemoteBackupRequestBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES),
            response: null,
        };
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return {
                body: null,
                response: createJsonBodyTooLargeResponse(),
            };
        }

        if (error instanceof JsonBodyParseError) {
            return {
                body: null,
                response: createJsonBodyParseErrorResponse(),
            };
        }

        throw error;
    }
}

export async function createRemoteBackupStatusResponse(): Promise<NextResponse> {
    try {
        const queueSnapshot = await getRemoteBackupQueueSnapshot();

        return NextResponse.json({
            ...getR2BackupStatus(),
            ...queueSnapshot,
        });
    } catch (error) {
        const invalidResponse = createInvalidR2SettingsResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}

export async function createRemoteBackupRetryFailedResponse(): Promise<NextResponse> {
    try {
        const result = await retryFailedRemoteBackups();

        return NextResponse.json({
            success: true,
            ...result,
            backupQueueMessage: null,
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const queueSnapshot = await getRemoteBackupQueueSnapshot();
        const message = queueSnapshot.backupQueueMessage ?? '失败备份任务重试失败。';

        return NextResponse.json(
            {
                message,
                ...queueSnapshot,
            },
            { status: 500 }
        );
    }
}

export async function createRemoteBackupSyncResponse(): Promise<NextResponse> {
    const remoteBackup = await syncCurrentBackupToRemote({
        reason: 'manual-sync',
        writeSnapshot: true,
    });
    const queueSnapshot = await getRemoteBackupQueueSnapshot();
    const status = remoteBackup.success
        ? 200
        : remoteBackup.enabled
            ? ('runtimeDataUnavailable' in remoteBackup && remoteBackup.runtimeDataUnavailable
                ? 503
                : 'invalidConfiguration' in remoteBackup && remoteBackup.invalidConfiguration
                    ? 500
                    : 502)
            : 409;

    return NextResponse.json(
        {
            success: remoteBackup.success,
            remoteBackup,
            ...queueSnapshot,
        },
        { status }
    );
}

export async function createRemoteBackupRestoreResponse(currentManifestValue: unknown): Promise<NextResponse> {
    try {
        const currentManifest = parseRestoreCurrentManifest(currentManifestValue);

        if (!currentManifest) {
            return createRestorePreconditionRequiredResponse();
        }

        const remoteRestore = await materializeLatestRemoteBackupData();
        const data = remoteRestore.data;

        assertEditorBackupRestoreCurrentManifest(currentManifest, {
            includeMedia: Boolean(data.media),
        });
        const preRestoreBackup = await syncCurrentBackupToRemote({
            reason: 'pre-remote-restore',
            writeSnapshot: true,
            writeLatest: false,
        });

        if (!preRestoreBackup.success) {
            return createRemoteBackupFailureResponse(preRestoreBackup);
        }

        const result = await restoreEditorBackupData(data, { currentManifest });

        const remoteBackup = await syncCurrentBackupToRemote({
            reason: 'remote-restore',
            writeSnapshot: true,
        });
        if (shouldQueueRemoteBackupRetry(remoteBackup)) {
            await queueCurrentBackupToRemote({
                reason: 'remote-restore',
                writeSnapshot: true,
            });
        }
        invalidatePublicContentCache('remote-restore');
        const queueSnapshot = await getRemoteBackupQueueSnapshot();

        return NextResponse.json({
            success: true,
            counts: {
                articles: result.articles,
                categories: result.categories,
                settings: result.settings,
                media: result.media,
            },
            mediaRestore: remoteRestore.mediaRestore,
            format: remoteRestore.format,
            remoteBackup,
            ...queueSnapshot,
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

        const invalidR2SettingsResponse = createInvalidR2SettingsResponse(error);

        if (invalidR2SettingsResponse) {
            return invalidR2SettingsResponse;
        }

        if (error instanceof EditorMediaRestoreDownloadError) {
            const queueSnapshot = await getRemoteBackupQueueSnapshot();

            return NextResponse.json(
                {
                    message: 'R2 媒体文件不完整或校验失败，已取消恢复。',
                    mediaRestore: error.result,
                    ...queueSnapshot,
                },
                { status: 502 }
            );
        }

        if (error instanceof R2BackupPayloadTooLargeError) {
            return createRemoteBackupPayloadTooLargeResponse(error);
        }

        const status = error instanceof R2BackupSettingsInvalidError
            ? 500
            : error instanceof R2BackupNotConfiguredError
                ? 503
                : 502;

        return NextResponse.json(
            {
                message: getRemoteRestoreErrorMessage(error),
            },
            { status }
        );
    }
}
