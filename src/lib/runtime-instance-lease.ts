import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LEASE_FILE_NAME = '.runtime-instance.lock';
const LEASE_STALE_AFTER_MS = 90_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;

interface RuntimeInstanceLease {
    pid: number;
    hostname: string;
    startedAt: string;
    token: string;
}

export class RuntimeInstanceAlreadyRunningError extends Error {
    constructor(public readonly leasePath: string, public readonly lease: RuntimeInstanceLease | null) {
        super(`Another blog-navigation instance owns the runtime data root: ${leasePath}`);
        this.name = 'RuntimeInstanceAlreadyRunningError';
    }
}

export interface RuntimeInstanceLeaseHandle {
    path: string;
    release(): void;
}

function getLeasePath(dataRoot: string): string {
    return path.join(dataRoot, LEASE_FILE_NAME);
}

function readLease(filePath: string): RuntimeInstanceLease | null {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RuntimeInstanceLease>;
        if (
            typeof value.pid !== 'number' ||
            typeof value.hostname !== 'string' ||
            typeof value.startedAt !== 'string' ||
            typeof value.token !== 'string'
        ) {
            return null;
        }

        return value as RuntimeInstanceLease;
    } catch {
        return null;
    }
}

function readLeaseWithMtime(filePath: string): { lease: RuntimeInstanceLease; mtimeMs: number } | null {
    const lease = readLease(filePath);

    if (!lease) {
        return null;
    }

    try {
        return { lease, mtimeMs: fs.statSync(filePath).mtimeMs };
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // ESRCH means the process is gone; EPERM and unknown errors keep the lease reserved.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function isLeaseStale(filePath: string): boolean {
    try {
        return Date.now() - fs.statSync(filePath).mtimeMs > LEASE_STALE_AFTER_MS;
    } catch {
        return true;
    }
}

// A heartbeat can never be refreshed once its process is gone, so a lease owned
// by a dead process on this host is reclaimed immediately instead of after the
// stale window. The lease is re-read right before removal so a lease recreated
// by a live peer in between is never deleted. Foreign hosts keep the mtime rule
// because their process liveness cannot be observed from here.
function reclaimDeadLease(filePath: string): boolean {
    const first = readLeaseWithMtime(filePath);

    if (
        !first ||
        first.lease.hostname !== os.hostname() ||
        !Number.isInteger(first.lease.pid) || first.lease.pid <= 0 ||
        isProcessAlive(first.lease.pid)
    ) {
        return false;
    }

    const second = readLeaseWithMtime(filePath);

    if (
        !second ||
        second.lease.token !== first.lease.token ||
        second.lease.pid !== first.lease.pid ||
        second.mtimeMs !== first.mtimeMs
    ) {
        return false;
    }

    fs.rmSync(filePath, { force: true });
    return true;
}

function writeLease(fileDescriptor: number, lease: RuntimeInstanceLease): void {
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(lease)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
}

export function acquireRuntimeInstanceLease(dataRoot: string): RuntimeInstanceLeaseHandle {
    fs.mkdirSync(dataRoot, { recursive: true });
    const leasePath = getLeasePath(dataRoot);
    const lease: RuntimeInstanceLease = {
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        token: crypto.randomBytes(16).toString('hex'),
    };
    let fileDescriptor: number | null = null;

    try {
        try {
            fileDescriptor = fs.openSync(leasePath, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }

            if (isLeaseStale(leasePath)) {
                fs.rmSync(leasePath, { force: true });
            } else if (!reclaimDeadLease(leasePath)) {
                throw new RuntimeInstanceAlreadyRunningError(leasePath, readLease(leasePath));
            }

            try {
                fileDescriptor = fs.openSync(leasePath, 'wx', 0o600);
            } catch (retryError) {
                if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
                    throw new RuntimeInstanceAlreadyRunningError(leasePath, readLease(leasePath));
                }

                throw retryError;
            }
        }

        writeLease(fileDescriptor, lease);
    } finally {
        if (fileDescriptor !== null) {
            fs.closeSync(fileDescriptor);
        }
    }

    let released = false;
    const heartbeat = setInterval(() => {
        if (released) {
            return;
        }

        try {
            const current = readLease(leasePath);
            if (current?.token !== lease.token) {
                return;
            }

            const now = new Date();
            fs.utimesSync(leasePath, now, now);
        } catch {
            // A lost lease is reported by the next startup; do not crash a live server.
        }
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    return {
        path: leasePath,
        release() {
            if (released) {
                return;
            }

            released = true;
            clearInterval(heartbeat);
            try {
                if (readLease(leasePath)?.token === lease.token) {
                    fs.rmSync(leasePath, { force: true });
                }
            } catch {
                // Shutdown must remain best-effort.
            }
        },
    };
}

export function getRuntimeInstanceLeasePath(dataRoot: string): string {
    return getLeasePath(dataRoot);
}

export const runtimeInstanceLeaseConstants = {
    staleAfterMs: LEASE_STALE_AFTER_MS,
    heartbeatIntervalMs: LEASE_HEARTBEAT_INTERVAL_MS,
};
