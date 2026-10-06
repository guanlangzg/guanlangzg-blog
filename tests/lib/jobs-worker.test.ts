import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, listJobs } from '@/lib/jobs/store';
import { runJobWorkerOnce, runJobWorkerLoop } from '@/lib/jobs/worker';

const originalDataRoot = process.env.BLOG_DATA_ROOT;
const roots: string[] = [];

function createDataRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-jobs-worker-'));
    roots.push(root);
    process.env.BLOG_DATA_ROOT = root;
    return root;
}

afterEach(() => {
    if (originalDataRoot === undefined) {
        delete process.env.BLOG_DATA_ROOT;
    } else {
        process.env.BLOG_DATA_ROOT = originalDataRoot;
    }

    while (roots.length > 0) {
        fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
});

describe('jobs worker', () => {
    it('records a blocked job as terminal failed without consuming network retries', async () => {
        createDataRoot();
        const job = await createJob({ type: 'backup', input: { revision: 'r1' } });

        const result = await runJobWorkerOnce({
            handlers: { backup: async () => ({ blocked: { message: 'configuration required' } }) },
        });

        expect(result).toMatchObject({ id: job.id, status: 'failed', attempt: 1, lastError: 'configuration required' });
        expect((await listJobs()).find((item) => item.id === job.id)?.status).toBe('failed');
    });

    it('does not execute a job twice when two workers start concurrently', async () => {
        createDataRoot();
        const job = await createJob({ type: 'backup', input: { revision: 'r1' } });
        let executions = 0;
        let releaseHandler: (() => void) | undefined;
        const handlerBlocked = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        const handler = async () => {
            executions += 1;
            await handlerBlocked;
        };

        const firstWorker = runJobWorkerOnce({ handlers: { backup: handler } });
        const secondWorker = runJobWorkerOnce({ handlers: { backup: handler } });
        await new Promise((resolve) => setTimeout(resolve, 25));
        releaseHandler?.();
        await Promise.all([firstWorker, secondWorker]);

        expect(executions).toBe(1);
        expect((await listJobs()).find((item) => item.id === job.id)?.status).toBe('succeeded');
    });

    it('keeps processing jobs while a persisted state file is corrupt and leaves it untouched', async () => {
        const root = createDataRoot();
        const job = await createJob({ type: 'backup', input: { revision: 'r1' } });
        const watermarkPath = path.join(root, 'workflow', 'backup-state.json');
        const corruptWatermark = 'not json at all';
        fs.writeFileSync(watermarkPath, corruptWatermark, 'utf8');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const abortController = new AbortController();

        const loop = runJobWorkerLoop({
            handlers: { backup: async () => undefined },
            pollIntervalMs: 10,
            signal: abortController.signal,
        });

        await vi.waitFor(async () => {
            expect((await listJobs()).find((item) => item.id === job.id)?.status).toBe('succeeded');
        }, { timeout: 5_000 });

        abortController.abort();
        await expect(loop).resolves.toBeUndefined();

        expect(fs.readFileSync(watermarkPath, 'utf8')).toBe(corruptWatermark);
        expect(consoleError).toHaveBeenCalledWith(
            '[jobs-watermark] Backup watermark file is invalid; dirty backup tracking is suspended until it is repaired:',
            watermarkPath
        );
    });

    it('keeps polling after a transient job store failure and logs fixed context only', async () => {
        const root = createDataRoot();
        const job = await createJob({ type: 'backup', input: { revision: 'r1' } });
        const jobPath = path.join(root, 'workflow', 'jobs', `${job.id}.json`);
        const renameSync = fs.renameSync;
        let injectedFailures = 0;

        vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
            if (String(newPath) === jobPath && injectedFailures === 0) {
                injectedFailures += 1;
                throw new Error('Simulated job store failure.');
            }

            return renameSync(oldPath, newPath);
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const abortController = new AbortController();

        const loop = runJobWorkerLoop({
            handlers: { backup: async () => undefined },
            pollIntervalMs: 10,
            signal: abortController.signal,
        });

        await vi.waitFor(async () => {
            expect((await listJobs()).find((item) => item.id === job.id)?.status).toBe('succeeded');
        }, { timeout: 5_000 });

        abortController.abort();
        await expect(loop).resolves.toBeUndefined();

        expect(injectedFailures).toBe(1);
        expect(consoleError).toHaveBeenCalledWith(
            '[jobs-worker] Job worker iteration failed; retrying:',
            expect.stringContaining('Error')
        );
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('Simulated job store failure');
    });
});
