import {
    createCurrentEditorManifestSnapshotReference,
    createCurrentEditorRemoteBackupPackage,
    createEditorDataManifestHash,
    isSameEditorManifestSnapshot,
} from '@/lib/editor-data-backup';
import {
    BackupCoordinatorStateInvalidError,
    drainPendingBackupTasks,
    enqueuePendingBackupTask,
    getBackupQueueStatus,
    resetBackupCoordinatorForTests,
    retryFailedBackupTasks,
    waitForBackupCoordinatorIdleForTests,
    type BackupTask,
    type BackupQueueStatus,
} from '@/lib/backup-coordinator';
import {
    getR2BackupConfig,
    getR2BackupStatus,
    R2BackupSettingsInvalidError,
} from '@/lib/r2-backup-storage';
import {
    uploadChunkedBackupToR2,
    type R2ChunkedUploadResult,
} from '@/lib/r2-chunked-backup-storage';
import { EditorDataRootUnavailableError } from '@/lib/editor-data-storage';

export type RemoteBackupResult =
    | {
        enabled: false;
        success: false;
        message: string;
    }
    | {
        enabled: true;
        success: true;
        format?: R2ChunkedUploadResult['format'];
        latestKey: string | null;
        snapshotKey: string | null;
        counts?: R2ChunkedUploadResult['counts'];
    }
    | {
        enabled: true;
        success: false;
        message: string;
        invalidConfiguration?: boolean;
        runtimeDataUnavailable?: boolean;
    };

export type QueuedRemoteBackupResult =
    | {
        queued: false;
        enabled: false;
        success: false;
        message: string;
    }
    | {
        queued: true;
        enabled: true;
        success: null;
        message: string;
    }
    | {
        queued: false;
        enabled: true;
        success: false;
        message: string;
        invalidConfiguration?: boolean;
        queueStateInvalid?: boolean;
    };

type RemoteBackupOptions = {
    reason: string;
    writeSnapshot?: boolean;
    writeLatest?: boolean;
    expectedSnapshotManifest?: BackupTask['snapshotManifest'];
    expectedSnapshotManifestHash?: string;
};

function getErrorMessage(error: unknown): string {
    if (error instanceof R2BackupSettingsInvalidError) {
        return 'Cloudflare R2 配置文件损坏，请修复或删除后重试。';
    }

    if (error instanceof EditorDataRootUnavailableError) {
        return '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。';
    }

    return error instanceof Error && error.message ? error.message : 'Remote backup failed.';
}

function createQueuedResult(): QueuedRemoteBackupResult {
    return {
        queued: true,
        enabled: true,
        success: null,
        message: 'R2 backup sync has been queued.',
    };
}

function getQueueStateInvalidMessage(_error: BackupCoordinatorStateInvalidError): string {
    return '云端备份队列状态文件损坏，请检查并修复。';
}

export async function queueCurrentBackupToRemote(options: {
    reason: string;
    writeSnapshot?: boolean;
    writeLatest?: boolean;
}): Promise<QueuedRemoteBackupResult> {
    try {
        const config = getR2BackupConfig();
        const status = getR2BackupStatus();

        if (!status.enabled) {
            return {
                queued: false,
                enabled: false,
                success: false,
                message: 'R2 backup is disabled.',
            };
        }

        if (!config) {
            return {
                queued: false,
                enabled: true,
                success: false,
                message: status.message ?? 'R2 backup is not configured.',
            };
        }

        await enqueueRemoteBackup({
            reason: options.reason,
            writeSnapshot: options.writeSnapshot ?? config.snapshotOnWrite,
            writeLatest: options.writeLatest,
        });

        return createQueuedResult();
    } catch (error) {
        if (error instanceof R2BackupSettingsInvalidError) {
            return {
                queued: false,
                enabled: true,
                success: false,
                invalidConfiguration: true,
                message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
            };
        }

        if (error instanceof BackupCoordinatorStateInvalidError) {
            return {
                queued: false,
                enabled: true,
                success: false,
                queueStateInvalid: true,
                message: getQueueStateInvalidMessage(error),
            };
        }

        throw error;
    }
}

async function enqueueRemoteBackup(options: RemoteBackupOptions): Promise<void> {
    const snapshotReference = options.writeSnapshot
        ? createCurrentEditorManifestSnapshotReference()
        : null;

    await enqueuePendingBackupTask({
        reason: options.reason,
        writeSnapshot: Boolean(options.writeSnapshot),
        writeLatest: options.writeLatest,
        snapshotManifest: snapshotReference?.manifest,
        snapshotManifestHash: snapshotReference?.manifestHash,
    });
    void drainPendingBackups();
}

async function executePendingBackupTask(task: BackupTask): Promise<boolean> {
    const result = await syncCurrentBackupToRemote({
        reason: task.reason,
        writeSnapshot: task.writeSnapshot,
        writeLatest: task.writeLatest,
        expectedSnapshotManifest: task.snapshotManifest,
        expectedSnapshotManifestHash: task.snapshotManifestHash,
    });

    if (result.enabled === true && result.success === true) {
        return true;
    }

    throw new Error(result.message);
}

export async function drainPendingBackups(): Promise<void> {
    await drainPendingBackupTasks(executePendingBackupTask);
}

export async function getRemoteBackupQueueStatus(): Promise<BackupQueueStatus> {
    return getBackupQueueStatus();
}

export type RemoteBackupQueueSnapshot = {
    backupQueue: BackupQueueStatus | null;
    backupQueueMessage: string | null;
};

function getRemoteBackupQueueStatusErrorMessage(error: unknown): string {
    if (error instanceof BackupCoordinatorStateInvalidError) {
        return '云端备份队列状态文件损坏，请检查并修复。';
    }

    return '云端备份队列状态读取失败。';
}

export async function getRemoteBackupQueueSnapshot(): Promise<RemoteBackupQueueSnapshot> {
    try {
        return {
            backupQueue: await getRemoteBackupQueueStatus(),
            backupQueueMessage: null,
        };
    } catch (error) {
        return {
            backupQueue: null,
            backupQueueMessage: getRemoteBackupQueueStatusErrorMessage(error),
        };
    }
}

export async function retryFailedRemoteBackups(): Promise<{ retried: number; backupQueue: BackupQueueStatus }> {
    const retried = await retryFailedBackupTasks();

    if (retried > 0) {
        void drainPendingBackups();
    }

    return {
        retried,
        backupQueue: await getRemoteBackupQueueStatus(),
    };
}

export function shouldQueueRemoteBackupRetry(remoteBackup: RemoteBackupResult): boolean {
    return (
        remoteBackup.enabled === true &&
        remoteBackup.success === false &&
        !('invalidConfiguration' in remoteBackup && remoteBackup.invalidConfiguration) &&
        !('runtimeDataUnavailable' in remoteBackup && remoteBackup.runtimeDataUnavailable)
    );
}

export async function syncCurrentBackupToRemote(options: RemoteBackupOptions): Promise<RemoteBackupResult> {
    let config;
    let status;

    try {
        config = getR2BackupConfig();
        status = getR2BackupStatus();
    } catch (error) {
        if (error instanceof R2BackupSettingsInvalidError) {
            return {
                enabled: true,
                success: false,
                invalidConfiguration: true,
                message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
            };
        }

        throw error;
    }

    if (!status.enabled) {
        return {
            enabled: false,
            success: false,
            message: 'R2 backup is disabled.',
        };
    }

    if (!config) {
        return {
            enabled: true,
            success: false,
            message: status.message ?? 'R2 backup is not configured.',
        };
    }

    try {
        const backupPackage = await createCurrentEditorRemoteBackupPackage();
        const payload = backupPackage.payload;
        const currentManifest = payload.manifest;

        if (options.writeSnapshot && options.expectedSnapshotManifest) {
            if (!currentManifest || !isSameEditorManifestSnapshot(options.expectedSnapshotManifest, currentManifest)) {
                throw new Error('R2 snapshot manifest changed before upload; snapshot was not written.');
            }
        }

        if (options.writeSnapshot && options.expectedSnapshotManifestHash && currentManifest) {
            const currentManifestHash = createEditorDataManifestHash(currentManifest);

            if (currentManifestHash !== options.expectedSnapshotManifestHash) {
                throw new Error('R2 snapshot manifest hash changed before upload; snapshot was not written.');
            }
        }

        const chunkedResult = await uploadChunkedBackupToR2(backupPackage, {
            reason: options.reason,
            writeSnapshot: options.writeSnapshot ?? config.snapshotOnWrite,
            writeLatest: options.writeLatest,
        });

        return {
            enabled: true,
            success: true,
            format: chunkedResult.format,
            latestKey: chunkedResult.latestKey,
            snapshotKey: chunkedResult.snapshotKey,
            counts: chunkedResult.counts,
        };
    } catch (error) {
        console.error('[editor-remote-backup] Failed to sync backup to R2:', error);

        return {
            enabled: true,
            success: false,
            ...(error instanceof EditorDataRootUnavailableError
                ? { runtimeDataUnavailable: true }
                : {}),
            message: getErrorMessage(error),
        };
    }
}

export function resetRemoteBackupQueueForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetRemoteBackupQueueForTests must not be called in production.');
    }

    resetBackupCoordinatorForTests();
}

export async function waitForRemoteBackupQueueIdleForTests(): Promise<void> {
    await waitForBackupCoordinatorIdleForTests();
}
