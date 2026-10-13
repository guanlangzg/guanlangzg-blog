import path from 'node:path';
import { getAppVersionInfo } from '@/lib/app-version';
import { readEditorDataManifest } from '@/lib/editor-data-storage';
import { inspectPersistedBackupState } from '@/lib/jobs/watermark';
import { getRuntimeDataRoot, getRuntimeDataRootPath } from '@/lib/runtime-config';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';

type HealthCheckStatus = 'ok' | 'degraded';

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
    const persistedState = readPersistedStateStatus();
    const status: HealthCheckStatus =
        basePayload.dataRoot.writable && manifest.valid && persistedState.valid ? 'ok' : 'degraded';

    return {
        status,
        ...basePayload,
        manifest,
        persistedState,
    };
}
