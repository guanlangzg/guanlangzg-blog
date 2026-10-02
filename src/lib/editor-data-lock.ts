import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const DATA_LOCK_DIRECTORY_NAME = '.data-write.lock';
const DATA_LOCK_HEARTBEAT_FILE_NAME = 'heartbeat.json';
const DATA_LOCK_WAIT_TIMEOUT_MS = 5000;
const DATA_LOCK_STALE_MS = 30 * 1000;
const DATA_LOCK_HEARTBEAT_MS = 10 * 1000;
const DATA_LOCK_RETRY_MS = 50;
const EDITOR_DATA_ROOT_UNAVAILABLE_ERROR_CODES = new Set([
    'EACCES',
    'ENOENT',
    'ENOTDIR',
    'EPERM',
    'EROFS',
]);

export class EditorDataLockTimeoutError extends Error {
    constructor(public readonly lockPath: string) {
        super('Timed out while waiting for the editor data write lock.');
        this.name = 'EditorDataLockTimeoutError';
    }
}

export class EditorDataRootUnavailableError extends Error {
    constructor(
        public readonly rootPath: string,
        public readonly code: string | null
    ) {
        super('Runtime data root is unavailable.');
        this.name = 'EditorDataRootUnavailableError';
    }
}

export type EditorDataRootLock = {
    directory: string;
    token: string;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
};

type EditorDataLockSnapshot = {
    mtimeMs: number;
    owner: string | null;
    pid: number | null;
};

const heldEditorDataLockContext = new AsyncLocalStorage<Map<string, number>>();

async function sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getLockDirectory(root: string): string {
    return path.join(root, DATA_LOCK_DIRECTORY_NAME);
}

function getLockHeartbeatPath(lockDirectory: string): string {
    return path.join(lockDirectory, DATA_LOCK_HEARTBEAT_FILE_NAME);
}

function readLockOwner(lockDirectory: string): string | null {
    try {
        return fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

function getLockOwnerToken(lockDirectory: string): string | null {
    const owner = readLockOwner(lockDirectory);

    if (!owner) {
        return null;
    }

    try {
        const parsed = JSON.parse(owner) as { token?: unknown };

        return typeof parsed.token === 'string' ? parsed.token : null;
    } catch {
        return null;
    }
}

function getLockOwnerPid(owner: string | null): number | null {
    if (!owner) {
        return null;
    }

    try {
        const parsed = JSON.parse(owner) as { pid?: unknown };
        return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
            ? parsed.pid as number
            : null;
    } catch {
        return null;
    }
}

function readLockSnapshot(lockDirectory: string): EditorDataLockSnapshot | null {
    try {
        const owner = readLockOwner(lockDirectory);
        const stats = fs.statSync(
            fs.existsSync(getLockHeartbeatPath(lockDirectory))
                ? getLockHeartbeatPath(lockDirectory)
                : lockDirectory
        );

        return {
            mtimeMs: stats.mtimeMs,
            owner,
            pid: getLockOwnerPid(owner),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        throw error;
    }
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

        if (code === 'ESRCH') {
            return false;
        }

        if (code === 'EPERM') {
            return true;
        }

        return true;
    }
}

function isLockStale(snapshot: EditorDataLockSnapshot): boolean {
    return Date.now() - snapshot.mtimeMs > DATA_LOCK_STALE_MS && !isProcessAlive(snapshot.pid);
}

function isSameLockSnapshot(
    first: EditorDataLockSnapshot,
    second: EditorDataLockSnapshot
): boolean {
    return first.mtimeMs === second.mtimeMs && first.owner === second.owner;
}

function removeStaleLockIfUnchanged(
    lockDirectory: string,
    staleSnapshot: EditorDataLockSnapshot
): boolean {
    const currentSnapshot = readLockSnapshot(lockDirectory);

    if (!currentSnapshot) {
        return true;
    }

    if (!isSameLockSnapshot(staleSnapshot, currentSnapshot)) {
        return false;
    }

    fs.rmSync(lockDirectory, { recursive: true, force: true });
    return true;
}

function writeLockHeartbeat(lock: Pick<EditorDataRootLock, 'directory' | 'token'>): void {
    if (getLockOwnerToken(lock.directory) !== lock.token) {
        return;
    }

    fs.writeFileSync(
        getLockHeartbeatPath(lock.directory),
        JSON.stringify({
            token: lock.token,
            pid: process.pid,
            heartbeatAt: new Date().toISOString(),
        }, null, 2),
        'utf8'
    );
}

function startLockHeartbeat(lock: Pick<EditorDataRootLock, 'directory' | 'token'>): ReturnType<typeof setInterval> {
    writeLockHeartbeat(lock);
    const heartbeatTimer = setInterval(() => {
        try {
            writeLockHeartbeat(lock);
        } catch (error) {
            console.error('[editor-data-lock] Failed to refresh data write lock heartbeat:', error);
        }
    }, DATA_LOCK_HEARTBEAT_MS);

    heartbeatTimer.unref?.();
    return heartbeatTimer;
}

function tryAcquireLockCore(lockDirectory: string, token: string): EditorDataRootLock | null {
    try {
        fs.mkdirSync(lockDirectory);

        try {
            fs.writeFileSync(
                path.join(lockDirectory, 'owner.json'),
                JSON.stringify({
                    token,
                    pid: process.pid,
                    acquiredAt: new Date().toISOString(),
                }, null, 2),
                'utf8'
            );
        } catch (error) {
            fs.rmSync(lockDirectory, { recursive: true, force: true });
            throw error;
        }

        const lock = {
            directory: lockDirectory,
            token,
        };

        return {
            directory: lockDirectory,
            token,
            heartbeatTimer: startLockHeartbeat(lock),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }

        const snapshot = readLockSnapshot(lockDirectory);

        if (!snapshot) {
            return null;
        }

        if (isLockStale(snapshot) && removeStaleLockIfUnchanged(lockDirectory, snapshot)) {
            return null;
        }

        return null;
    }
}

export async function acquireEditorDataRootLock(root: string): Promise<EditorDataRootLock> {
    const resolvedRoot = path.resolve(root);
    const lockDirectory = getLockDirectory(resolvedRoot);
    const deadline = Date.now() + DATA_LOCK_WAIT_TIMEOUT_MS;
    const token = `${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`;

    try {
        fs.mkdirSync(resolvedRoot, { recursive: true });

        while (true) {
            const lock = tryAcquireLockCore(lockDirectory, token);

            if (lock) {
                return lock;
            }

            if (Date.now() >= deadline) {
                throw new EditorDataLockTimeoutError(lockDirectory);
            }

            await sleep(DATA_LOCK_RETRY_MS);
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code ?? null;

        if (code && EDITOR_DATA_ROOT_UNAVAILABLE_ERROR_CODES.has(code)) {
            throw new EditorDataRootUnavailableError(resolvedRoot, code);
        }

        throw error;
    }
}

export function releaseEditorDataRootLock(lock: EditorDataRootLock): void {
    if (lock.heartbeatTimer) {
        clearInterval(lock.heartbeatTimer);
    }

    if (getLockOwnerToken(lock.directory) !== lock.token) {
        return;
    }

    fs.rmSync(lock.directory, { recursive: true, force: true });
}

export function getHeldEditorDataLockCount(root: string): number {
    return heldEditorDataLockContext.getStore()?.get(path.resolve(root)) ?? 0;
}

export function runWithHeldEditorDataLockContext<T>(
    root: string,
    operation: () => T | Promise<T>
): T | Promise<T> {
    const resolvedRoot = path.resolve(root);
    const nextContext = new Map(heldEditorDataLockContext.getStore());

    nextContext.set(resolvedRoot, (nextContext.get(resolvedRoot) ?? 0) + 1);

    return heldEditorDataLockContext.run(nextContext, operation);
}
