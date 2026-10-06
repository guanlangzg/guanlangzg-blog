import path from 'node:path';
import { getAppVersionInfo } from '@/lib/app-version';
import { BackupCoordinatorStateInvalidError } from '@/lib/backup-coordinator';
import { getRemoteBackupQueueStatus } from '@/lib/editor-remote-backup';
import { readEditorDataManifest } from '@/lib/editor-data-storage';
import { inspectPersistedBackupState } from '@/lib/jobs/watermark';
import { getRuntimeDataRoot, getRuntimeDataRootPath } from '@/lib/runtime-config';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';

export type HealthCheckStatus = 'ok' | 'degraded';

type BackupQueueStatus =
    | Awaited<ReturnType<typeof getRemoteBackupQueueStatus>>
    | {
        pending: null;
        failed: null;
        failedTasks: [];
        message: string;
    };

type AnonymousBackupQueueStatus = {
    pending: number | null;
    failed: number | null;
    failedTasks: Array<{
        id: string;
        reason: string;
        attempts: number;
        lastAttemptAt: string | null;
        lastError: null;
    }>;
    message?: string;
};

type ManifestStatus =
    | {
        valid: true;
        updatedAt: string;
        schemaVersion: number | null;
    }
    | {
        valid: false;
        message: string;
    };

type PersistedStateStatus = {
    valid: boolean;
    invalidFiles: Array<{ file: string; reason: string }>;
    jobCounts: {
        pending: number;
        running: number;
        failed: number;
    };
    message?: string;
};

async function createBaseHealthPayload() {
    const dataRoot = getRuntimeDataRoot();
    const writable = await hasWritableRuntimeDataRoot();

    return {
        version: getAppVersionInfo(),
        dataRoot: {
            source: dataRoot.source,
            writable,
        },
    };
}

function readManifestStatus(): ManifestStatus {
    try {
        const currentManifest = readEditorDataManifest();

        return {
            valid: true,
            updatedAt: currentManifest.updatedAt,
            schemaVersion: currentManifest.schemaVersion ?? null,
        };
    } catch (error) {
        return {
            valid: false,
            message: error instanceof Error ? error.message : 'Manifest check failed.',
        };
    }
}

async function readBackupQueueStatus(): Promise<BackupQueueStatus> {
    try {
        return await getRemoteBackupQueueStatus();
    } catch (error) {
        return {
            pending: null,
            failed: null,
            failedTasks: [],
            message: error instanceof BackupCoordinatorStateInvalidError
                ? 'Pending backup queue state is invalid.'
                : 'Backup queue status is unavailable.',
        };
    }
}

// Anonymous callers only need to know that failures exist; raw remote error
// text can carry bucket names and endpoint hosts, and stays available to
// authenticated editors through /api/data/backup.
function createAnonymousBackupQueueStatus(status: BackupQueueStatus): AnonymousBackupQueueStatus {
    if (status.pending === null || status.failed === null) {
        return {
            pending: status.pending,
            failed: status.failed,
            failedTasks: [],
            message: status.message,
        };
    }

    return {
        pending: status.pending,
        failed: status.failed,
        failedTasks: status.failedTasks.map((task) => ({
            id: task.id,
            reason: task.reason,
            attempts: task.attempts,
            lastAttemptAt: task.lastAttemptAt,
            lastError: null,
        })),
    };
}

// Read-only and lock-free: a public probe must never wait on the editor data
// write lock nor rewrite the files it inspects.
function readPersistedStateStatus(): PersistedStateStatus {
    try {
        const dataRoot = getRuntimeDataRootPath();
        const inspection = inspectPersistedBackupState(dataRoot);

        return {
            valid: inspection.invalidFiles.length === 0,
            invalidFiles: inspection.invalidFiles.map((file) => ({
                file: path.relative(dataRoot, file.path).split(path.sep).join('/'),
                reason: file.reason,
            })),
            jobCounts: inspection.jobCounts,
        };
    } catch {
        return {
            valid: false,
            invalidFiles: [],
            jobCounts: { pending: 0, running: 0, failed: 0 },
            message: 'Persisted state check failed.',
        };
    }
}

export async function getHealthPayload() {
    const basePayload = await createBaseHealthPayload();
    const status: HealthCheckStatus = basePayload.dataRoot.writable ? 'ok' : 'degraded';

    return {
        status,
        ...basePayload,
    };
}

export async function getReadinessPayload() {
    const basePayload = await createBaseHealthPayload();
    const manifest = readManifestStatus();
    const backupQueue = createAnonymousBackupQueueStatus(await readBackupQueueStatus());
    const persistedState = readPersistedStateStatus();
    const status: HealthCheckStatus =
        basePayload.dataRoot.writable && manifest.valid && persistedState.valid ? 'ok' : 'degraded';

    return {
        status,
        ...basePayload,
        manifest,
        backupQueue,
        persistedState,
    };
}
