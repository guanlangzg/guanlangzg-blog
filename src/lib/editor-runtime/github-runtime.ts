import { GitHubRestClient } from '@/lib/github/client';
import { GitHubAppTokenManager } from '@/lib/github/app';
import { readGitHubConnection, type GitHubRepositoryReference } from '@/lib/github/config';

export interface PublishingWorkflowRun {
    id: number;
    branch: string;
    workflow: string;
    runAttempt: number;
    status: string;
    conclusion: string | null;
    headSha: string;
}

export interface PublishingDeploymentAttempt {
    runId: number;
    runAttempt: number;
    branch: string;
    workflow: string;
    status: string;
    conclusion: string | null;
    headSha: string;
    jobs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        steps: Array<{ name: string; status: string; conclusion: string | null }>;
    }>;
}

/**
 * Read-only Pages operations used to prove a specific deployment. Every call is narrowed to
 * the pages repository; the client is constructed from the stored App connection so no token
 * ever travels through application code.
 */
export interface PublishingGitHubRuntime {
    prepareClient(): Promise<GitHubRestClient>;
    readHistoryApiOptions(): { repository: GitHubRepositoryReference; tokenProvider: GitHubAppTokenManager };
    listRunsByHeadSha(headSha: string, workflowPath: string): Promise<PublishingWorkflowRun[]>;
    getAttemptWithJobs(runId: number, attempt: number): Promise<PublishingDeploymentAttempt>;
    rerunRun(runId: number): Promise<void>;
    getPagesHeadCommitSha(branch: string): Promise<string>;
    getPagesSiteUrl(): Promise<string>;
}

function normalizeWorkflowSelector(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized.includes('/') ? normalized : `.github/workflows/${normalized}`;
}

function normalizeWorkflowPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toRun(value: Awaited<ReturnType<GitHubRestClient['getRunAttempt']>>): PublishingWorkflowRun {
    return {
        id: value.id,
        branch: value.headBranch,
        workflow: value.workflowPath,
        runAttempt: value.runAttempt,
        status: value.status,
        conclusion: value.conclusion,
        headSha: value.headSha,
    };
}

function toJobs(value: Awaited<ReturnType<GitHubRestClient['getRunAttemptJobs']>>): PublishingDeploymentAttempt['jobs'] {
    return value.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        steps: job.steps,
    }));
}

export async function createPublishingGitHubRuntime(): Promise<PublishingGitHubRuntime | null> {
    const connection = await readGitHubConnection();
    if (!connection || connection.status !== 'connected') return null;

    const tokenProvider = new GitHubAppTokenManager({
        appId: connection.appId,
        installationId: connection.installationId,
        repositories: connection.repos,
    });
    const client = new GitHubRestClient({
        repositories: connection.repos,
        tokenProvider,
    });

    return {
        prepareClient: async () => client,
        // Article history reads the private backup repository's commit history.
        readHistoryApiOptions: () => ({ repository: connection.repos.backup, tokenProvider }),
        listRunsByHeadSha: async (headSha, workflowPath) => {
            const workflow = normalizeWorkflowSelector(workflowPath);
            const workflowSelector = workflowPath.replace(/\\/g, '/').replace(/^\.\//, '');
            const runs = [];
            for (let page = 1; ; page += 1) {
                const batch = await client.listWorkflowRunsByHeadSha(headSha, { workflow: workflowSelector, page, perPage: 100 });
                runs.push(...batch.filter((run) => normalizeWorkflowPath(run.workflowPath) === workflow).map(toRun));
                if (batch.length < 100) return runs;
            }
        },
        getAttemptWithJobs: async (runId, attempt) => {
            const run = toRun(await client.getRunAttempt(runId, attempt));
            const jobs = [];
            for (let page = 1; ; page += 1) {
                const batch = await client.getRunAttemptJobs(runId, attempt, { page, perPage: 100 });
                jobs.push(...toJobs(batch));
                if (batch.length < 100) return { ...run, runId: run.id, jobs };
            }
        },
        rerunRun: async (runId) => {
            await client.rerunWorkflowRun(runId);
        },
        getPagesHeadCommitSha: async (branch) => {
            const reference = await client.getReference('pages', branch) as { object?: { sha?: unknown } };
            const sha = reference.object?.sha;
            if (typeof sha !== 'string') throw new Error('Pages branch head is unavailable.');
            return sha;
        },
        getPagesSiteUrl: async () => (await client.getGitHubPages()).url,
    };
}
