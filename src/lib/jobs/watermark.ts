import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { createJobUnderLock } from '@/lib/jobs/store';

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

export function readBackupWatermarkUnderLock(root: string): BackupWatermarkState {
    const filePath = watermarkPath(root);
    if (!fs.existsSync(filePath)) {
        const initial = createInitialBackupWatermark();
        writeJsonAtomically(filePath, initial);
        return initial;
    }

    const parsed = parseBackupWatermark(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
    if (!parsed) {
        throw new Error(`Invalid backup watermark: ${filePath}`);
    }

    return parsed;
}

export async function readBackupWatermark(): Promise<BackupWatermarkState> {
    return withRuntimeDataRootLock(() => readBackupWatermarkUnderLock(getRuntimeDataRootPath()));
}

export function isBackupCaughtUp(state: BackupWatermarkState): boolean {
    return state.blockedReason === null && state.backedUpThrough >= state.contentSequence;
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

export function ensureDirtyBackupJobUnderLock(root: string): void {
    const state = readBackupWatermarkUnderLock(root);
    if (isBackupCaughtUp(state)) {
        return;
    }

    const jobsDirectory = path.join(root, 'workflow', 'jobs');
    if (fs.existsSync(jobsDirectory)) {
        for (const fileName of fs.readdirSync(jobsDirectory)) {
            if (!fileName.endsWith('.json')) {
                continue;
            }

            const job = JSON.parse(fs.readFileSync(path.join(jobsDirectory, fileName), 'utf8')) as {
                type?: unknown;
                input?: { generation?: unknown; contentSequence?: unknown };
                status?: unknown;
            };
            if (
                job.type === 'backup' &&
                job.input?.generation === state.generation &&
                job.input.contentSequence === state.contentSequence &&
                (job.status === 'pending' || job.status === 'retry' || job.status === 'running')
            ) {
                return;
            }
        }
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
