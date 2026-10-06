import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import {
    createJobUnderLock,
    inspectJobsDirectory,
    type InvalidPersistedFile,
    type JobRecord,
} from '@/lib/jobs/store';

export interface BackupWatermarkState {
    generation: string;
    contentSequence: number;
    backedUpThrough: number;
    blockedReason: string | null;
}

export interface VerifiedFullBackup {
    generation: string;
    contentSequence: number;
    remoteCommit: string;
}

const WATERMARK_RELATIVE_PATH = path.join('workflow', 'backup-state.json');

function watermarkPath(root: string): string {
    return path.join(root, WATERMARK_RELATIVE_PATH);
}

export function createInitialBackupWatermark(generation = randomUUID()): BackupWatermarkState {
    return {
        generation,
        contentSequence: 0,
        backedUpThrough: 0,
        blockedReason: null,
    };
}

export function parseBackupWatermark(value: unknown): BackupWatermarkState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const candidate = value as Partial<BackupWatermarkState>;
    if (
        typeof candidate.generation !== 'string' || candidate.generation.length === 0 ||
        !Number.isSafeInteger(candidate.contentSequence) || (candidate.contentSequence ?? -1) < 0 ||
        !Number.isSafeInteger(candidate.backedUpThrough) || (candidate.backedUpThrough ?? -2) < -1 ||
        !(candidate.blockedReason === null || typeof candidate.blockedReason === 'string')
    ) {
        return null;
    }

    return {
        generation: candidate.generation,
        contentSequence: candidate.contentSequence as number,
        backedUpThrough: candidate.backedUpThrough as number,
        blockedReason: candidate.blockedReason as string | null,
    };
}

function readBackupWatermarkFile(root: string): { state: BackupWatermarkState | null; invalid: boolean } {
    const filePath = watermarkPath(root);

    if (!fs.existsSync(filePath)) {
        return { state: null, invalid: false };
    }

    try {
        const parsed = parseBackupWatermark(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
        return parsed ? { state: parsed, invalid: false } : { state: null, invalid: true };
    } catch {
        return { state: null, invalid: true };
    }
}

export function readBackupWatermarkUnderLock(root: string): BackupWatermarkState {
    const current = readBackupWatermarkFile(root);

    if (current.invalid) {
        throw new Error(`Invalid backup watermark: ${watermarkPath(root)}`);
    }

    if (current.state) {
        return current.state;
    }

    const initial = createInitialBackupWatermark();
    writeJsonAtomically(watermarkPath(root), initial);
    return initial;
}

export async function readBackupWatermark(): Promise<BackupWatermarkState> {
    return withRuntimeDataRootLock(() => readBackupWatermarkUnderLock(getRuntimeDataRootPath()));
}

export function isBackupCaughtUp(state: BackupWatermarkState): boolean {
    return state.blockedReason === null && state.backedUpThrough >= state.contentSequence;
}

export interface PersistedBackupStateInspection {
    watermarkPresent: boolean;
    watermarkInvalid: boolean;
    invalidFiles: InvalidPersistedFile[];
    jobCounts: {
        pending: number;
        running: number;
        failed: number;
    };
}

/**
 * Read-only inspection for readiness probes: it never acquires the data lock
 * (so a public probe can never reverse-wait behind a content writer) and never
 * writes, so damaged files are reported instead of being replaced.
 */
export function inspectPersistedBackupState(root: string): PersistedBackupStateInspection {
    const watermark = readBackupWatermarkFile(root);
    const { jobs, invalidFiles } = inspectJobsDirectory(root);

    return {
        watermarkPresent: watermark.state !== null,
        watermarkInvalid: watermark.invalid,
        invalidFiles: [
            ...(watermark.invalid ? [{ path: watermarkPath(root), reason: 'invalid backup watermark' }] : []),
            ...invalidFiles,
        ],
        jobCounts: {
            pending: jobs.filter((job) => job.status === 'pending' || job.status === 'retry').length,
            running: jobs.filter((job) => job.status === 'running').length,
            failed: jobs.filter((job) => job.status === 'failed').length,
        },
    };
}

export class BackupStateInvalidError extends Error {
    constructor(public readonly invalidFiles: InvalidPersistedFile[]) {
        super(`Backup state files are invalid: ${invalidFiles.map((file) => file.path).join(', ')}`);
        this.name = 'BackupStateInvalidError';
    }
}

/**
 * Content writes must refuse to start while backup bookkeeping is damaged, so a
 * write can never land without its dirty watermark entry and a damaged watermark
 * or job file is never silently replaced.
 */
export function assertBackupStateWritableUnderLock(root: string): BackupWatermarkState {
    const inspection = inspectPersistedBackupState(root);

    if (inspection.invalidFiles.length > 0) {
        throw new BackupStateInvalidError(inspection.invalidFiles);
    }

    return readBackupWatermarkUnderLock(root);
}

export function recordContentMutationUnderLock(
    root: string,
    input: { resource: string; revision: string; digest: string; value: unknown }
): BackupWatermarkState {
    const current = readBackupWatermarkUnderLock(root);
    const next: BackupWatermarkState = {
        ...current,
        contentSequence: current.contentSequence + 1,
    };
    writeJsonAtomically(watermarkPath(root), next);
    createJobUnderLock(root, {
        type: 'backup',
        input: {
            generation: next.generation,
            contentSequence: next.contentSequence,
            ...input,
        },
    });

    return next;
}

export function recordRestoredContentMutationUnderLock(
    root: string,
    input: { digest: string; value: unknown }
): BackupWatermarkState {
    const current = readBackupWatermarkFile(root);
    if (current.invalid) {
        throw new BackupStateInvalidError([{ path: watermarkPath(root), reason: 'invalid backup watermark' }]);
    }

    const next = {
        generation: randomUUID(),
        contentSequence: 1,
        backedUpThrough: 0,
        blockedReason: null,
    };
    writeJsonAtomically(watermarkPath(root), next);
    createJobUnderLock(root, {
        type: 'backup',
        input: {
            generation: next.generation,
            contentSequence: next.contentSequence,
            resource: 'restore',
            revision: `generation-${next.generation}`,
            ...input,
        },
    });
    return next;
}

export function recordVerifiedFullBackupUnderLock(
    root: string,
    backup: VerifiedFullBackup
): BackupWatermarkState {
    const current = readBackupWatermarkUnderLock(root);
    if (backup.generation !== current.generation || backup.contentSequence > current.contentSequence) {
        return current;
    }

    const backedUpThrough = Math.max(current.backedUpThrough, backup.contentSequence);
    const next = {
        ...current,
        backedUpThrough,
        blockedReason: backedUpThrough >= current.contentSequence ? null : current.blockedReason,
    };
    writeJsonAtomically(watermarkPath(root), next);
    return next;
}

export async function recordVerifiedFullBackup(backup: VerifiedFullBackup): Promise<BackupWatermarkState> {
    return withRuntimeDataRootLock(() =>
        recordVerifiedFullBackupUnderLock(getRuntimeDataRootPath(), backup)
    );
}

export async function startBackupGeneration(): Promise<BackupWatermarkState> {
    return withRuntimeDataRootLock(() => {
        const next = createInitialBackupWatermark();
        writeJsonAtomically(watermarkPath(getRuntimeDataRootPath()), next);
        return next;
    });
}

export async function setBackupBlockedReason(reason: string | null): Promise<BackupWatermarkState> {
    return withRuntimeDataRootLock(() => {
        const root = getRuntimeDataRootPath();
        const next = { ...readBackupWatermarkUnderLock(root), blockedReason: reason };
        writeJsonAtomically(watermarkPath(root), next);
        return next;
    });
}

function isDirtyBackupJob(job: JobRecord, state: BackupWatermarkState): boolean {
    if (
        job.type !== 'backup' ||
        (job.status !== 'pending' && job.status !== 'retry' && job.status !== 'running') ||
        !job.input || typeof job.input !== 'object' || Array.isArray(job.input)
    ) {
        return false;
    }

    const input = job.input as Record<string, unknown>;
    return input.generation === state.generation && input.contentSequence === state.contentSequence;
}

export function ensureDirtyBackupJobUnderLock(root: string): void {
    const current = readBackupWatermarkFile(root);

    if (current.invalid) {
        console.error(
            '[jobs-watermark] Backup watermark file is invalid; dirty backup tracking is suspended until it is repaired:',
            watermarkPath(root)
        );
        return;
    }

    const state = current.state ?? readBackupWatermarkUnderLock(root);

    if (isBackupCaughtUp(state)) {
        return;
    }

    if (inspectJobsDirectory(root).jobs.some((job) => isDirtyBackupJob(job, state))) {
        return;
    }

    createJobUnderLock(root, {
        type: 'backup',
        input: {
            generation: state.generation,
            contentSequence: state.contentSequence,
            resource: 'recovery-scan',
            revision: `sequence-${state.contentSequence}`,
            digest: 'recovery-scan',
            value: null,
        },
    });
}

export async function reconcileDirtyBackupJob(): Promise<void> {
    await withRuntimeDataRootLock(() => ensureDirtyBackupJobUnderLock(getRuntimeDataRootPath()));
}
