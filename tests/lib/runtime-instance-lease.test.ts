import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    acquireRuntimeInstanceLease,
    getRuntimeInstanceLeasePath,
    runtimeInstanceLeaseConstants,
    RuntimeInstanceAlreadyRunningError,
} from '@/lib/runtime-instance-lease';

const tempRoots: string[] = [];

function createTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-instance-lease-'));
    tempRoots.push(root);
    return root;
}

afterEach(() => {
    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

describe('runtime instance lease', () => {
    it('creates a lease and removes only its own lease on release', () => {
        const root = createTempRoot();
        const handle = acquireRuntimeInstanceLease(root);
        const leasePath = getRuntimeInstanceLeasePath(root);

        expect(fs.existsSync(leasePath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(leasePath, 'utf8'))).toEqual(expect.objectContaining({
            pid: process.pid,
            hostname: expect.any(String),
            token: expect.any(String),
        }));

        handle.release();
        expect(fs.existsSync(leasePath)).toBe(false);
        handle.release();
    });

    it('rejects a second live instance on the same data root', () => {
        const root = createTempRoot();
        const first = acquireRuntimeInstanceLease(root);

        expect(() => acquireRuntimeInstanceLease(root)).toThrow(RuntimeInstanceAlreadyRunningError);
        first.release();
    });

    it('reclaims a stale lease', () => {
        const root = createTempRoot();
        const leasePath = getRuntimeInstanceLeasePath(root);
        fs.writeFileSync(leasePath, JSON.stringify({
            pid: 999999,
            hostname: 'old-host',
            startedAt: new Date(0).toISOString(),
            token: 'old-token',
        }));
        const staleAt = new Date(Date.now() - runtimeInstanceLeaseConstants.staleAfterMs - 1);
        fs.utimesSync(leasePath, staleAt, staleAt);

        const handle = acquireRuntimeInstanceLease(root);

        expect(JSON.parse(fs.readFileSync(leasePath, 'utf8')).token).not.toBe('old-token');
        handle.release();
    });
});
