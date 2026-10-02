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

function isLeaseStale(filePath: string): boolean {
    try {
        return Date.now() - fs.statSync(filePath).mtimeMs > LEASE_STALE_AFTER_MS;
    } catch {
        return true;
    }
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
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !isLeaseStale(leasePath)) {
                throw new RuntimeInstanceAlreadyRunningError(leasePath, readLease(leasePath));
            }

            fs.rmSync(leasePath, { force: true });
            fileDescriptor = fs.openSync(leasePath, 'wx', 0o600);
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
