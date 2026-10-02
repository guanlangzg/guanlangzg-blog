import { getAppVersionInfo } from '@/lib/app-version';
import { getRemoteBackupQueueStatus } from '@/lib/editor-remote-backup';
import { readEditorDataManifest } from '@/lib/editor-data-storage';
import { getRuntimeDataRoot } from '@/lib/runtime-config';
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
            message: error instanceof Error ? error.message : 'Backup queue check failed.',
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
    const backupQueue = await readBackupQueueStatus();
    const status: HealthCheckStatus =
        basePayload.dataRoot.writable && manifest.valid ? 'ok' : 'degraded';

    return {
        status,
        ...basePayload,
        manifest,
        backupQueue,
    };
}
