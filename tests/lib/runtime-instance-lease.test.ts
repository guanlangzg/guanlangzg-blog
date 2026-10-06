import { spawn, spawnSync } from 'node:child_process';
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
const childProcesses: Array<ReturnType<typeof spawn>> = [];
const LEASE_MODULE_PATH = path.resolve(process.cwd(), 'src', 'lib', 'runtime-instance-lease.ts');

function runChildProcess(script: string, args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ['--experimental-transform-types', '-e', script, ...args], {
        encoding: 'utf8',
    });
}

const ACQUIRE_AND_EXIT_SCRIPT = `
const { pathToFileURL } = require('node:url');
(async () => {
    const mod = await import(pathToFileURL(process.argv[1]).href);
    mod.acquireRuntimeInstanceLease(process.argv[2]);
    process.exit(0);
})().catch((error) => { console.error('CHILD-FAIL', error && error.name); process.exit(1); });
`;

const HOLD_LEASE_SCRIPT = `
const { pathToFileURL } = require('node:url');
(async () => {
    const mod = await import(pathToFileURL(process.argv[1]).href);
    const handle = mod.acquireRuntimeInstanceLease(process.argv[2]);
    process.stdout.write('lease-ready\\n');
    process.on('SIGTERM', () => { handle.release(); process.exit(0); });
    setInterval(() => {}, 1000);
})().catch((error) => { console.error('CHILD-FAIL', error && error.name); process.exit(1); });
`;

function createTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-instance-lease-'));
    tempRoots.push(root);
    return root;
}

afterEach(() => {
    while (childProcesses.length > 0) {
        childProcesses.pop()?.kill('SIGTERM');
    }

    while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            callback();
        };
        const timeout = setTimeout(
            () => settle(() => reject(new Error('Timed out waiting for the child lease holder.'))),
            10_000
        );

        child.stdout?.on('data', (chunk: Buffer) => {
            if (chunk.toString('utf8').includes('lease-ready')) {
                settle(resolve);
            }
        });
        child.on('error', (error) => settle(() => reject(error)));
        child.on('exit', () => settle(() => reject(new Error('The child lease holder exited before becoming ready.'))));
    });
}

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

    it('reclaims a fresh lease whose owning process has already exited', () => {
        const root = createTempRoot();
        const acquired = runChildProcess(ACQUIRE_AND_EXIT_SCRIPT, [LEASE_MODULE_PATH, root]);
        expect(acquired.status, String(acquired.stderr ?? '')).toBe(0);

        const leasePath = getRuntimeInstanceLeasePath(root);
        const abandoned = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { token: string };
        expect(abandoned.token).toEqual(expect.any(String));

        const handle = acquireRuntimeInstanceLease(root);

        expect(JSON.parse(fs.readFileSync(leasePath, 'utf8')).token).not.toBe(abandoned.token);
        handle.release();
    });

    it('still rejects a lease held by a live process on this host', async () => {
        const root = createTempRoot();
        const child = spawn(process.execPath, [
            '--experimental-transform-types',
            '-e',
            HOLD_LEASE_SCRIPT,
            LEASE_MODULE_PATH,
            root,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        childProcesses.push(child);
        await waitForChildReady(child);

        expect(() => acquireRuntimeInstanceLease(root)).toThrow(RuntimeInstanceAlreadyRunningError);
    });
});
