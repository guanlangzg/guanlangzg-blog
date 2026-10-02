import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    parseEditorDataManifest,
    type EditorDataManifest,
} from '@/lib/editor-data-storage';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';

const PENDING_BACKUP_FILE_NAME = '.backup-pending.json';
const PENDING_BACKUP_LOCK_DIRECTORY_NAME = '.backup-pending.lock';
const PENDING_BACKUP_DRAIN_LOCK_DIRECTORY_NAME = '.backup-pending-drain.lock';
const PENDING_BACKUP_LOCK_WAIT_TIMEOUT_MS = 5000;
const PENDING_BACKUP_LOCK_STALE_MS = 30 * 1000;
const PENDING_BACKUP_LOCK_RETRY_MS = 25;
const PENDING_BACKUP_STATE_VERSION = 2;
const MAX_BACKUP_TASK_ATTEMPTS = 3;

export type BackupTaskStatus = 'pending' | 'failed';

export interface BackupTask {
    id: string;
    reason: string;
    timestamp: string;
    retries: number;
    attempts: number;
    status: BackupTaskStatus;
    writeSnapshot: boolean;
    writeLatest?: boolean;
    snapshotManifest?: EditorDataManifest;
    snapshotManifestHash?: string;
    nextAttemptAt?: string;
    lastError?: string;
    lastAttemptAt?: string;
}

export interface PendingBackupState {
    version: typeof PENDING_BACKUP_STATE_VERSION;
    tasks: BackupTask[];
}

export interface BackupTaskInput {
    reason: string;
    writeSnapshot: boolean;
    writeLatest?: boolean;
    snapshotManifest?: EditorDataManifest;
    snapshotManifestHash?: string;
}

type DrainOptions = {
    retryDelayMs?: (retries: number) => number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
};

type PendingBackupLock = {
    path: string;
    token: string;
};

export class BackupCoordinatorStateInvalidError extends Error {
    constructor(public readonly filePath: string) {
        super('Pending backup queue state is invalid.');
        this.name = 'BackupCoordinatorStateInvalidError';
    }
}

let activeDrain: Promise<void> | null = null;

function getPendingBackupFilePath(): string {
    return path.join(getRuntimeDataRootPath(), PENDING_BACKUP_FILE_NAME);
}

function getPendingBackupLockPath(): string {
    return path.join(getRuntimeDataRootPath(), PENDING_BACKUP_LOCK_DIRECTORY_NAME);
}

function getPendingBackupDrainLockPath(): string {
    return path.join(getRuntimeDataRootPath(), PENDING_BACKUP_DRAIN_LOCK_DIRECTORY_NAME);
}

function sleepAsync(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function isProcessAlive(pid: number | null): boolean {
    if (!pid) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        return code !== 'ESRCH';
    }
}

function readLockPid(lockPath: string): number | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };

        return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 ? parsed.pid as number : null;
    } catch {
        return null;
    }
}

function removeStaleLock(lockPath: string): boolean {
    try {
        const stats = fs.statSync(lockPath);

        if (Date.now() - stats.mtimeMs <= PENDING_BACKUP_LOCK_STALE_MS || isProcessAlive(readLockPid(lockPath))) {
            return false;
        }

        fs.rmSync(lockPath, { recursive: true, force: true });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }

        throw error;
    }
}

function readLockToken(lockPath: string): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as { token?: unknown };

        return typeof parsed.token === 'string' ? parsed.token : null;
    } catch {
        return null;
    }
}

async function acquireDirectoryLock(lockPath: string, timeoutMessage: string): Promise<PendingBackupLock> {
    const deadline = Date.now() + PENDING_BACKUP_LOCK_WAIT_TIMEOUT_MS;
    const token = `${process.pid}-${Date.now()}-${randomUUID()}`;

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    while (true) {
        try {
            fs.mkdirSync(lockPath);
            fs.writeFileSync(
                path.join(lockPath, 'owner.json'),
                JSON.stringify({
                    token,
                    pid: process.pid,
                    acquiredAt: new Date().toISOString(),
                }, null, 2),
                'utf8'
            );
            return {
                path: lockPath,
                token,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }

            if (removeStaleLock(lockPath)) {
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(timeoutMessage);
            }

            await sleepAsync(PENDING_BACKUP_LOCK_RETRY_MS);
        }
    }
}

async function acquirePendingBackupQueueLock(): Promise<PendingBackupLock> {
    return acquireDirectoryLock(
        getPendingBackupLockPath(),
        'Timed out while waiting for the pending backup queue lock.'
    );
}

async function acquirePendingBackupDrainLock(): Promise<PendingBackupLock> {
    return acquireDirectoryLock(
        getPendingBackupDrainLockPath(),
        'Timed out while waiting for the pending backup drain lock.'
    );
}

function releaseDirectoryLock(lock: PendingBackupLock): void {
    if (readLockToken(lock.path) !== lock.token) {
        return;
    }

    fs.rmSync(lock.path, { recursive: true, force: true });
}

function releasePendingBackupQueueLock(lock: PendingBackupLock): void {
    releaseDirectoryLock(lock);
}

function releasePendingBackupDrainLock(lock: PendingBackupLock): void {
    releaseDirectoryLock(lock);
}

async function withPendingBackupQueueLock<T>(operation: () => T): Promise<T> {
    const lockPath = await acquirePendingBackupQueueLock();

    try {
        return operation();
    } finally {
        releasePendingBackupQueueLock(lockPath);
    }
}

function fsyncFile(filePath: string): void {
    const fileDescriptor = fs.openSync(filePath, 'r+');

    try {
        fs.fsyncSync(fileDescriptor);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function fsyncDirectory(directoryPath: string): void {
    try {
        const fileDescriptor = fs.openSync(directoryPath, 'r');

        try {
            fs.fsyncSync(fileDescriptor);
        } finally {
            fs.closeSync(fileDescriptor);
        }
    } catch (error) {
        if (process.platform !== 'win32') {
            throw error;
        }
    }
}

function createEmptyState(): PendingBackupState {
    return {
        version: PENDING_BACKUP_STATE_VERSION,
        tasks: [],
    };
}

function isTask(value: unknown): value is BackupTask {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Partial<BackupTask>;

    return (
        typeof candidate.id === 'string' &&
        typeof candidate.reason === 'string' &&
        typeof candidate.timestamp === 'string' &&
        typeof candidate.retries === 'number' &&
        Number.isInteger(candidate.retries) &&
        candidate.retries >= 0 &&
        (candidate.attempts === undefined || (typeof candidate.attempts === 'number' && Number.isInteger(candidate.attempts) && candidate.attempts >= 0)) &&
        (candidate.status === undefined || candidate.status === 'pending' || candidate.status === 'failed') &&
        typeof candidate.writeSnapshot === 'boolean' &&
        (candidate.writeLatest === undefined || typeof candidate.writeLatest === 'boolean') &&
        (candidate.snapshotManifest === undefined || parseEditorDataManifest(candidate.snapshotManifest) !== null) &&
        (candidate.snapshotManifestHash === undefined || typeof candidate.snapshotManifestHash === 'string') &&
        (candidate.nextAttemptAt === undefined || typeof candidate.nextAttemptAt === 'string') &&
        (candidate.lastError === undefined || typeof candidate.lastError === 'string') &&
        (candidate.lastAttemptAt === undefined || typeof candidate.lastAttemptAt === 'string')
    );
}

function normalizeTask(task: BackupTask): BackupTask {
    return {
        ...task,
        attempts: task.attempts ?? task.retries,
        status: task.status ?? 'pending',
    };
}

function parseState(value: unknown, filePath: string): PendingBackupState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BackupCoordinatorStateInvalidError(filePath);
    }

    const candidate = value as Partial<PendingBackupState>;

    if (
        (candidate.version !== PENDING_BACKUP_STATE_VERSION && candidate.version !== 1) ||
        !Array.isArray(candidate.tasks) ||
        candidate.tasks.some((task) => !isTask(task))
    ) {
        throw new BackupCoordinatorStateInvalidError(filePath);
    }

    return {
        version: PENDING_BACKUP_STATE_VERSION,
        tasks: candidate.tasks.map((task) => normalizeTask(task as BackupTask)),
    };
}

function readState(): PendingBackupState {
    const filePath = getPendingBackupFilePath();

    if (!fs.existsSync(filePath)) {
        return createEmptyState();
    }

    try {
        return parseState(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown, filePath);
    } catch (error) {
        if (error instanceof BackupCoordinatorStateInvalidError) {
            throw error;
        }

        throw new BackupCoordinatorStateInvalidError(filePath);
    }
}

function writeState(state: PendingBackupState): void {
    const filePath = getPendingBackupFilePath();
    const directoryPath = path.dirname(filePath);
    fs.mkdirSync(directoryPath, { recursive: true });

    if (state.tasks.length === 0) {
        fs.rmSync(filePath, { force: true });
        fsyncDirectory(directoryPath);
        return;
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fsyncFile(tempPath);
        fs.renameSync(tempPath, filePath);
        fsyncDirectory(directoryPath);
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
}

function createTask(input: BackupTaskInput, now: Date): BackupTask {
    return {
        id: randomUUID(),
        reason: input.reason,
        timestamp: now.toISOString(),
        retries: 0,
        attempts: 0,
        status: 'pending',
        writeSnapshot: input.writeSnapshot,
        writeLatest: input.writeLatest,
        snapshotManifest: input.snapshotManifest,
        snapshotManifestHash: input.snapshotManifestHash,
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function getRetryDelayMs(retries: number, options: DrainOptions): number {
    return options.retryDelayMs?.(retries) ?? 250 * (2 ** Math.max(0, retries - 1));
}

function sleep(milliseconds: number, options: DrainOptions): Promise<void> {
    if (milliseconds <= 0) {
        return Promise.resolve();
    }

    if (options.sleep) {
        return options.sleep(milliseconds);
    }

    return sleepAsync(milliseconds);
}

function findNextTask(tasks: BackupTask[], now: Date): BackupTask | null {
    const nowTime = now.getTime();

    return tasks.find((task) => {
        if (task.status === 'failed') {
            return false;
        }

        if (task.retries >= MAX_BACKUP_TASK_ATTEMPTS) {
            return false;
        }

        if (!task.nextAttemptAt) {
            return true;
        }

        return Date.parse(task.nextAttemptAt) <= nowTime;
    }) ?? null;
}

function findNextAttemptDelay(tasks: BackupTask[], now: Date): number | null {
    const futureTimes = tasks
        .filter((task) => task.status !== 'failed' && task.retries < MAX_BACKUP_TASK_ATTEMPTS && task.nextAttemptAt)
        .map((task) => Date.parse(task.nextAttemptAt as string))
        .filter((time) => Number.isFinite(time) && time > now.getTime())
        .sort((left, right) => left - right);

    return futureTimes.length > 0 ? futureTimes[0] - now.getTime() : null;
}

async function removeTask(taskId: string): Promise<void> {
    await withPendingBackupQueueLock(() => {
        const state = readState();
        writeState({
            ...state,
            tasks: state.tasks.filter((task) => task.id !== taskId),
        });
    });
}

async function updateTaskAfterFailure(task: BackupTask, error: unknown, now: Date, options: DrainOptions): Promise<boolean> {
    const retries = task.retries + 1;
    const lastError = getErrorMessage(error);
    const lastAttemptAt = now.toISOString();

    const retryDelayMs = getRetryDelayMs(retries, options);
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const shouldRetry = retries < MAX_BACKUP_TASK_ATTEMPTS;

    await withPendingBackupQueueLock(() => {
        const state = readState();
        writeState({
            ...state,
            tasks: state.tasks.map((currentTask) => currentTask.id === task.id
                ? {
                    ...currentTask,
                    retries,
                    attempts: retries,
                    status: shouldRetry ? 'pending' : 'failed',
                    nextAttemptAt: shouldRetry ? nextAttemptAt : undefined,
                    lastError,
                    lastAttemptAt,
                }
                : currentTask),
        });
    });

    return shouldRetry;
}

async function runDrain(
    execute: (task: BackupTask) => Promise<boolean>,
    options: DrainOptions
): Promise<void> {
    while (true) {
        const now = options.now?.() ?? new Date();
        const state = await withPendingBackupQueueLock(() => readState());
        const task = findNextTask(state.tasks, now);

        if (!task) {
            const delayMs = findNextAttemptDelay(state.tasks, now);

            if (delayMs === null) {
                return;
            }

            await sleep(delayMs, options);
            continue;
        }

        try {
            const success = await execute(task);

            if (success) {
                await removeTask(task.id);
            } else {
                const shouldRetry = await updateTaskAfterFailure(task, new Error('Backup task failed.'), now, options);

                if (shouldRetry) {
                    await sleep(getRetryDelayMs(task.retries + 1, options), options);
                }
            }
        } catch (error) {
            const shouldRetry = await updateTaskAfterFailure(task, error, now, options);

            if (shouldRetry) {
                await sleep(getRetryDelayMs(task.retries + 1, options), options);
            }
        }
    }
}

export async function enqueuePendingBackupTask(input: BackupTaskInput): Promise<BackupTask> {
    return withPendingBackupQueueLock(() => {
        const state = readState();
        const task = createTask(input, new Date());

        writeState({
            ...state,
            tasks: [...state.tasks, task],
        });

        return task;
    });
}

export async function readPendingBackupTasksForTests(): Promise<BackupTask[]> {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('readPendingBackupTasksForTests must not be called in production.');
    }

    return withPendingBackupQueueLock(() => readState().tasks);
}

export type BackupQueueStatus = {
    pending: number;
    failed: number;
    failedTasks: Array<{
        id: string;
        reason: string;
        attempts: number;
        lastAttemptAt: string | null;
        lastError: string | null;
    }>;
};

export async function getBackupQueueStatus(): Promise<BackupQueueStatus> {
    return withPendingBackupQueueLock(() => {
        const tasks = readState().tasks;
        const failedTasks = tasks.filter((task) => task.status === 'failed');

        return {
            pending: tasks.filter((task) => task.status !== 'failed').length,
            failed: failedTasks.length,
            failedTasks: failedTasks.map((task) => ({
                id: task.id,
                reason: task.reason,
                attempts: task.attempts,
                lastAttemptAt: task.lastAttemptAt ?? null,
                lastError: task.lastError ?? null,
            })),
        };
    });
}

export async function retryFailedBackupTasks(): Promise<number> {
    return withPendingBackupQueueLock(() => {
        const state = readState();
        const failedTasks = state.tasks.filter((task) => task.status === 'failed');

        if (failedTasks.length === 0) {
            return 0;
        }

        writeState({
            ...state,
            tasks: state.tasks.map((task) => task.status === 'failed'
                ? {
                    ...task,
                    retries: 0,
                    attempts: 0,
                    status: 'pending',
                    nextAttemptAt: undefined,
                }
                : task),
        });

        return failedTasks.length;
    });
}

export async function drainPendingBackupTasks(
    execute: (task: BackupTask) => Promise<boolean>,
    options: DrainOptions = {}
): Promise<void> {
    if (activeDrain) {
        return activeDrain;
    }

    // Assign activeDrain before acquiring the drain lock so a fire-and-forget
    // drain is visible to waiters immediately; otherwise callers awaiting idle
    // could observe a null activeDrain in the microtask gap and skip waiting.
    const drainPromise = (async () => {
        const drainLockPath = await acquirePendingBackupDrainLock();

        return runDrain(execute, options).finally(() => {
            releasePendingBackupDrainLock(drainLockPath);
        });
    })();

    activeDrain = drainPromise.finally(() => {
        activeDrain = null;
    });

    return activeDrain;
}

export function resetBackupCoordinatorForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetBackupCoordinatorForTests must not be called in production.');
    }

    activeDrain = null;
    fs.rmSync(getPendingBackupFilePath(), { force: true });
    fs.rmSync(getPendingBackupLockPath(), { recursive: true, force: true });
    fs.rmSync(getPendingBackupDrainLockPath(), { recursive: true, force: true });
}

export async function waitForBackupCoordinatorIdleForTests(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('waitForBackupCoordinatorIdleForTests must not be called in production.');
    }

    while (activeDrain) {
        await activeDrain.catch(() => undefined);
        await Promise.resolve();
    }
}
