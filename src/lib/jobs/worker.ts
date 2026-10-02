import { recordVerifiedFullBackup } from '@/lib/jobs/watermark';
import {
    claimNextJob,
    completeClaimedJob,
    failClaimedJob,
    blockClaimedJob,
    deferClaimedJob,
    heartbeatClaimedJob,
    recoverPersistedJobs,
    type JobRecord,
    type JobType,
} from '@/lib/jobs/store';

export interface JobHandlerResult {
    remoteCommit?: string;
    verifiedFullBackup?: boolean;
    defer?: { message: string };
    blocked?: { message: string };
}

export type JobHandler = (job: JobRecord) => Promise<void | JobHandlerResult>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerOptions {
    handlers: JobHandlers;
    now?: () => Date;
    leaseMs?: number;
}

export async function runJobWorkerOnce(options: WorkerOptions): Promise<JobRecord | null> {
    const job = await claimNextJob({
        ...(options.now ? { now: options.now() } : {}),
        ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
        types: Object.keys(options.handlers) as JobType[],
    });
    if (!job) {
        return null;
    }

    const handler = options.handlers[job.type];
    if (!handler) {
        await failClaimedJob(job.id, new Error(`No handler registered for job type: ${job.type}`), {
            claimToken: job.claimToken,
            ...(options.now ? { now: options.now() } : {}),
        });
        return job;
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (options.leaseMs) {
        heartbeatTimer = setInterval(() => {
            void heartbeatClaimedJob(job.id, job.claimToken ?? '', { leaseMs: options.leaseMs })
                .catch((error: unknown) => console.error('[jobs-worker] Failed to refresh job lease:', error));
        }, Math.max(1, Math.floor(options.leaseMs / 3)));
        heartbeatTimer.unref?.();
    }

    try {
        const result = await handler(job);
        if (result?.blocked) {
            return await blockClaimedJob(job.id, result.blocked.message, {
                claimToken: job.claimToken,
                ...(options.now ? { now: options.now() } : {}),
            });
        }
        if (result?.defer) {
            return await deferClaimedJob(job.id, result.defer.message, {
                claimToken: job.claimToken,
                ...(options.now ? { now: options.now() } : {}),
            });
        }
        if (result?.verifiedFullBackup && result.remoteCommit) {
            const input = job.input as { generation?: unknown; contentSequence?: unknown };
            if (typeof input.generation === 'string' && typeof input.contentSequence === 'number') {
                await recordVerifiedFullBackup({
                    generation: input.generation,
                    contentSequence: input.contentSequence,
                    remoteCommit: result.remoteCommit,
                });
            }
        }
        return await completeClaimedJob(job.id, job.claimToken, result ?? {}, options.now?.());
    } catch (error) {
        return await failClaimedJob(job.id, error, {
            claimToken: job.claimToken,
            ...(options.now ? { now: options.now() } : {}),
        });
    } finally {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
        }
    }
}

export interface WorkerLoopOptions extends WorkerOptions {
    pollIntervalMs?: number;
    signal?: AbortSignal;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timer.unref?.();
    });
}

export async function runJobWorkerLoop(options: WorkerLoopOptions): Promise<void> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const localAbortController = new AbortController();
    const signal = options.signal ?? localAbortController.signal;

    await recoverPersistedJobs({ ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
    while (!signal.aborted) {
        const job = await runJobWorkerOnce(options);
        if (!job) {
            await wait(pollIntervalMs, signal);
        }
    }
}
