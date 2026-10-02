import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJob, listJobs } from '@/lib/jobs/store';
import { runJobWorkerOnce } from '@/lib/jobs/worker';

const originalDataRoot = process.env.BLOG_DATA_ROOT;
const roots: string[] = [];

function createDataRoot(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-jobs-worker-'));
    roots.push(root);
    process.env.BLOG_DATA_ROOT = root;
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
});
