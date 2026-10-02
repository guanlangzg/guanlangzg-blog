import fs from 'node:fs';
import path from 'node:path';
import {
    readBaseSnapshot,
    readDraftSnapshot,
    findSealedArtifactRoot,
    readSealedArtifactIdentity,
    verifyBackupProof,
} from '@/lib/editor-runtime/adapters';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';
import { readNavigationIdentities } from '@/lib/publishing/store';
import { verifyArtifactTree } from '@/lib/public-build/runner';
import { createCandidate, computeCandidateDigest, computeSelectedRevision } from '@/lib/publishing/snapshot';
import { createPublishingGitHubRuntime } from '@/lib/editor-runtime/github-runtime';
import { createOrReuseActiveJobUnderLock, listJobsUnderLock, type JobRecord } from '@/lib/jobs/store';
import { readBackupWatermarkUnderLock } from '@/lib/jobs/watermark';
import { readLivePointer, readRelease, writeRelease } from '@/lib/publishing/store';
import { createReleaseRetryService, type RetryAdapter } from '@/lib/publishing/retry';
import type { PublishingTask } from '@/lib/publishing/service';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

function taskStatusOf(job: JobRecord): PublishingTask['status'] {
    if (job.status === 'succeeded') return 'succeeded';
    if (job.status === 'failed') return 'failed';
    if (job.status === 'running') return 'running';
    return 'pending';
}

function retryJobIdentity(release: ReleaseRecord) {
    if (release.retryFromAttempt === null || !release.artifactDigest) return null;
    return {
        releaseId: release.id,
        candidateDigest: release.candidateDigest,
        artifactDigest: release.artifactDigest,
        retry: true,
        retryFromAttempt: release.retryFromAttempt,
    };
}

function findPublishTask(release: ReleaseRecord): PublishingTask | null {
    const expected = retryJobIdentity(release);
    if (!expected) return null;
    const job = listJobsUnderLock(getRuntimeDataRootPath()).find((candidate) => {
        if (candidate.type !== 'publish') return false;
        const input = candidate.input as Record<string, unknown> | null;
        return input?.releaseId === expected.releaseId && input.candidateDigest === expected.candidateDigest
            && input.artifactDigest === expected.artifactDigest && input.retry === true
            && input.retryFromAttempt === expected.retryFromAttempt;
    });
    return job ? { id: job.id, releaseId: release.id, status: taskStatusOf(job) } : null;
}

function readSelectedInputs(release: ReleaseRecord, draft: SiteSnapshot): unknown {
    const scope = release.scope;
    if (scope.kind === 'article') {
        const article = draft.articles.find((item) => item.id === scope.articleId) ?? null;
        if (scope.action === 'withdraw') {
            const base = readBaseSnapshot();
            return {
                articleId: scope.articleId,
                baseLiveReleaseId: readLivePointer()?.releaseId ?? null,
                publishedArticle: base.articles.find((item) => item.id === scope.articleId) ?? null,
            };
        }
        return { scope, article };
    }
    if (scope.kind === 'navigation') {
        return { navigation: draft.navigation, identities: readNavigationIdentities() ?? createNavigationIdentityMap(draft.navigation) };
    }
    if (scope.kind === 'settings') return { settings: draft.settings };
    const requested = new Set(scope.articleIds);
    return {
        articles: draft.articles.filter((article) => requested.has(article.id)).sort((left, right) => left.id.localeCompare(right.id)),
        navigation: draft.navigation,
        identities: readNavigationIdentities() ?? createNavigationIdentityMap(draft.navigation),
        settings: draft.settings,
    };
}

function readCurrentInputs(release: ReleaseRecord, generation: string): { selectedRevision: string; baseLiveReleaseId: string | null } {
    const draft = readDraftSnapshot();
    const base = readBaseSnapshot();
    const candidate = createCandidate(base, draft, release.scope);
    const selectedRevision = computeSelectedRevision({
        scope: release.scope,
        generation,
        selectedInputs: readSelectedInputs(release, draft),
        media: candidate.media,
    });
    return { selectedRevision, baseLiveReleaseId: readLivePointer()?.releaseId ?? null };
}

function findPublicCommitShaForRun(runId: number): string | null {
    const releasesRoot = path.join(getRuntimeDataRootPath(), 'workflow', 'releases');
    if (!fs.existsSync(releasesRoot)) return null;
    for (const releaseId of fs.readdirSync(releasesRoot)) {
        try {
            const { release } = readRelease(releaseId);
            if (release.workflowRunId === runId && release.publicCommitSha) return release.publicCommitSha;
        } catch {
            // A malformed or partially written release must not break retry reconciliation.
        }
    }
    return null;
}

function persistPublishTask(release: ReleaseRecord): PublishingTask {
    const input = retryJobIdentity(release);
    if (!input) throw new Error('Retry attempt identity is incomplete.');
    const existing = findPublishTask(release);
    if (existing) return existing;
    const job = createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), {
        type: 'publish',
        id: `publish-${release.id}-retry-${release.retryFromAttempt}`,
        input,
    });
    const persistedInput = job.input as Record<string, unknown> | null;
    if (persistedInput?.retry !== true || persistedInput.retryFromAttempt !== release.retryFromAttempt
        || persistedInput.releaseId !== release.id || persistedInput.candidateDigest !== release.candidateDigest
        || persistedInput.artifactDigest !== release.artifactDigest) {
        throw new Error('An incompatible publish task already uses the retry task identity.');
    }
    return { id: job.id, releaseId: release.id, status: taskStatusOf(job) };
}

/**
 * Production retry adapter. Reruns keep the SAME workflow run and the SAME sealed artifact:
 * `getLatestAttempt` observes the new attempt and `rerunWorkflow` triggers it. Nothing here
 * creates a new commit, a new workflow dispatch, or a rebuild.
 */
function createRetryAdapter(runtime: Awaited<ReturnType<typeof createPublishingGitHubRuntime>>): RetryAdapter {
    if (!runtime) throw new Error('GitHub publish connection is not ready.');

    return {
        withContentLock: (operation) => withRuntimeDataRootLock(() => {
            const watermark = readBackupWatermarkUnderLock(getRuntimeDataRootPath());
            return operation({
                readRelease,
                writeRelease,
                readLiveReleaseId: () => readLivePointer()?.releaseId ?? null,
                readInputs: (release: ReleaseRecord) => {
                    const inputs = readCurrentInputs(release, watermark.generation);
                    return {
                        ...inputs,
                        selectedRevision: inputs.selectedRevision === release.selectedRevision ? inputs.selectedRevision : '',
                    };
                },
                readWatermark: () => watermark,
                isBackupProofValid: verifyBackupProof,
                verifyArtifactIdentity: (release: ReleaseRecord, snapshot: SiteSnapshot) => {
                    const identity = readSealedArtifactIdentity(release.id);
                    return Boolean(identity && release.artifactDigest
                        && identity.releaseId === release.id
                        && identity.candidateDigest === release.candidateDigest
                        && identity.artifactDigest === release.artifactDigest
                        && computeCandidateDigest(snapshot) === release.candidateDigest);
                },
                persistPublishTask: (release: ReleaseRecord) => persistPublishTask(release),
                findPublishTask: (releaseId: string) => {
                    const current = readRelease(releaseId).release;
                    return findPublishTask(current);
                },
            });
        }),
        verifyArtifactTree: async (release: ReleaseRecord) => {
            const root = findSealedArtifactRoot(release.id);
            if (!root) return null;
            const manifest = await verifyArtifactTree(root);
            return manifest.releaseId === release.id
                && manifest.candidateDigest === release.candidateDigest
                && manifest.artifactDigest === release.artifactDigest
                ? manifest
                : null;
        },
        verifyRetryPreconditions: async (release: ReleaseRecord) => {
            if (!release.publicCommitSha) return false;
            const branchHead = await runtime.getPagesHeadCommitSha(process.env.BLOG_PAGES_BRANCH?.trim() || 'main');
            return branchHead === release.publicCommitSha;
        },
        getLatestAttempt: async (runId: number) => {
            // The client lists runs by head commit, so resolve the run's commit from the
            // persisted release that owns it rather than guessing an attempt number.
            const head = findPublicCommitShaForRun(runId);
            if (!head) throw new Error('The workflow run could not be matched to a published release.');
            const workflow = process.env.BLOG_PAGES_WORKFLOW?.trim() || 'deploy.yml';
            const runs = await runtime.listRunsByHeadSha(head, workflow);
            const match = runs.filter((run) => run.id === runId).sort((a, b) => b.runAttempt - a.runAttempt)[0];
            if (!match) throw new Error('The workflow run could not be found for retry.');
            return match.runAttempt;
        },
        rerunWorkflow: async (runId: number) => {
            await runtime.rerunRun(runId);
        },
    };
}

export async function createEditorReleaseRetryService() {
    const runtime = await createPublishingGitHubRuntime();
    if (!runtime) throw new Error('GitHub publish connection is not ready.');
    return createReleaseRetryService({ adapter: createRetryAdapter(runtime) });
}
