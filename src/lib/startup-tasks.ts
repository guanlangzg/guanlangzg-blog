import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import {
    acquireRuntimeInstanceLease,
    type RuntimeInstanceLeaseHandle,
} from '@/lib/runtime-instance-lease';

let startupTasksStarted = false;
let runtimeInstanceLease: RuntimeInstanceLeaseHandle | null = null;
let jobWorkerAbortController: AbortController | null = null;
let shutdownSignalHandlersRegistered = false;

// A gracefully stopped process must release its runtime instance lease. Container
// restarts hand the next instance a different hostname, so its dead-process check
// cannot reclaim this lease before the stale window elapses.
function releaseRuntimeStateOnSignal(): void {
    stopServerStartupTasks();
}

function registerShutdownSignalHandlers(): void {
    if (shutdownSignalHandlersRegistered) {
        return;
    }

    shutdownSignalHandlersRegistered = true;
    process.once('SIGINT', releaseRuntimeStateOnSignal);
    process.once('SIGTERM', releaseRuntimeStateOnSignal);
}

function unregisterShutdownSignalHandlers(): void {
    shutdownSignalHandlersRegistered = false;
    process.off('SIGINT', releaseRuntimeStateOnSignal);
    process.off('SIGTERM', releaseRuntimeStateOnSignal);
}

async function verifyMediaStorageConsistency(): Promise<void> {
    const { verifyEditorMediaStorageConsistency } = await import('@/lib/editor-media-storage');
    const report = await verifyEditorMediaStorageConsistency();

    if (report.missingFiles.length === 0 && report.hashMismatches.length === 0 && report.orphanFiles.length === 0) {
        return;
    }

    console.warn('[startup-tasks] Media storage consistency issues detected:', report);
}

async function startJobWorker(signal: AbortSignal): Promise<void> {
    const [worker, backupService, checkService, buildRuntime, pagesRuntime] = await Promise.all([
        import('@/lib/jobs/worker'),
        import('@/lib/github/backup-service'),
        import('@/lib/github/check-service'),
        import('@/lib/editor-runtime/build-runtime'),
        import('@/lib/editor-runtime/pages-runtime'),
    ]);
    if (signal.aborted) return;

    const handlers = {
        'github-check': checkService.createGitHubCheckJobHandler(),
        build: buildRuntime.createBuildJobHandler(),
    } as import('@/lib/jobs/worker').JobHandlers;

    try {
        const pagesHandlers = await pagesRuntime.createPagesJobHandlers();
        if (pagesHandlers && !signal.aborted) {
            handlers.publish = pagesHandlers.publish;
            handlers.reconcile = pagesHandlers.reconcile;
        }
    } catch (error) {
        if (!signal.aborted) {
            console.warn('[startup-tasks] GitHub Pages handlers are unavailable; publish jobs remain queryable:', error);
        }
    }

    try {
        const client = await backupService.createConfiguredGitHubBackupClient();
        if (!signal.aborted) {
            handlers.backup = backupService.createGitHubBackupJobHandler(client);
        }
    } catch (error) {
        if (!signal.aborted) {
            console.warn('[startup-tasks] GitHub backup handler is unavailable; local jobs remain queryable:', error);
        }
    }

    if (signal.aborted) return;
    await worker.runJobWorkerLoop({ handlers, signal });
}

// Verifies the runtime data root is writable so misconfiguration surfaces at
// startup instead of during the first write attempt. Errors are logged only;
// they do not abort startup so the process can still serve read-only traffic.
function verifyDataRootWritable(): void {
    const dataRoot = getRuntimeDataRootPath();
    const probePath = path.join(dataRoot, `.startup-probe-${process.pid}-${Date.now()}.tmp`);

    try {
        fs.mkdirSync(dataRoot, { recursive: true });
        fs.writeFileSync(probePath, 'startup-probe', 'utf8');
        fs.unlinkSync(probePath);
    } catch (error) {
        console.error(`[startup-tasks] Data root is not writable: ${dataRoot}`, error);
    }
}

export function startServerStartupTasks(): void {
    if (startupTasksStarted) {
        return;
    }

    startupTasksStarted = true;
    runtimeInstanceLease = acquireRuntimeInstanceLease(getRuntimeDataRootPath());
    registerShutdownSignalHandlers();
    verifyDataRootWritable();

    void verifyMediaStorageConsistency().catch((error) => {
        console.error('[startup-tasks] Failed to verify media storage consistency:', error);
    });

    jobWorkerAbortController = new AbortController();
    void startJobWorker(jobWorkerAbortController.signal).catch((error: unknown) => {
        if (!jobWorkerAbortController?.signal.aborted) {
            console.error('[startup-tasks] Failed to start persisted job worker:', error);
        }
    });
}

function stopServerStartupTasks(): void {
    unregisterShutdownSignalHandlers();
    jobWorkerAbortController?.abort();
    jobWorkerAbortController = null;

    runtimeInstanceLease?.release();
    runtimeInstanceLease = null;
    startupTasksStarted = false;
}

export function resetServerStartupTasksForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetServerStartupTasksForTests must not be called in production.');
    }

    stopServerStartupTasks();
}
