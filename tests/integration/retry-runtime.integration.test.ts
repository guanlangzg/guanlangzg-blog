import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { computeCandidateDigest, computeSelectedRevision } from '@/lib/publishing/snapshot';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const state = vi.hoisted(() => ({
  manifestIdentity: { releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64) },
  sealedTreeValid: true,
  runnerCalls: 0,
  rootLookups: 0,
  sealedTreeIdentity: null as { releaseId: string; candidateDigest: string; artifactDigest: string } | null,
  release: null as ReleaseRecord | null,
  snapshot: null as SiteSnapshot | null,
  pointer: null as { releaseId: string } | null,
  watermark: { generation: 'generation-1', contentSequence: 3, backedUpThrough: 3, blockedReason: null as string | null },
  jobs: [] as Array<{ id: string; type: string; input: unknown; status: 'pending' | 'running' | 'succeeded' | 'failed' }>,
  draft: null as SiteSnapshot | null,
  branch: 'main',
  workflow: 'deploy.yml',
  lastRunQuery: null as { head: string; workflow: string } | null,
  lastBranchQuery: '',
  lastRunQueries: [] as Array<{ head: string; workflow: string }>,
  artifactVerifications: 0,
  contentLockDepth: 0,
  verifyLockDepths: [] as number[],
  afterArtifactVerification: null as (() => Promise<void> | void) | null,
  currentAttempt: 1,
  reruns: 0,
  headCommit: 'f'.repeat(40),
}));

vi.mock('@/lib/editor-runtime/github-runtime', () => ({
  createPublishingGitHubRuntime: async () => ({
    getPagesSiteUrl: async () => 'https://example.com',
    getPagesHeadCommitSha: async (branch: string) => { state.lastBranchQuery = branch; return state.headCommit; },
    listRunsByHeadSha: async (head: string, workflow: string) => {
      state.lastRunQuery = { head, workflow };
      state.lastRunQueries.push({ head, workflow });
      return [{ id: 71, branch: state.branch, workflow: state.workflow, runAttempt: state.currentAttempt, status: 'completed', conclusion: 'failure', headSha: 'f'.repeat(40) }];
    },
    rerunRun: async () => { state.reruns += 1; state.currentAttempt += 1; },
  }),
}));

vi.mock('@/lib/editor-runtime/adapters', () => ({
  findSealedArtifactRoot: () => {
    state.rootLookups += 1;
    return 'sealed-root';
  },
  readSealedArtifactIdentity: () => structuredClone(state.manifestIdentity),
  verifyBackupProof: () => true,
  readDraftSnapshot: () => structuredClone(state.draft),
  readBaseSnapshot: () => ({
    schemaVersion: 1, siteId: 'site', articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
    media: [], redirects: [], removedPaths: [],
  }),
  readSnapshotMedia: () => [],
  readSelectedInputs: () => ({ settings: state.draft?.settings }),
}));

vi.mock('@/lib/public-build/runner', () => ({
  verifyArtifactTree: async () => {
    state.runnerCalls += 1;
    state.artifactVerifications += 1;
    state.verifyLockDepths.push(state.contentLockDepth);
    await state.afterArtifactVerification?.();
    if (!state.sealedTreeValid) throw new Error('Artifact bytes do not match the sealed manifest');
    return structuredClone(state.sealedTreeIdentity ?? state.manifestIdentity);
  },
}));

vi.mock('@/lib/editor-data-storage', () => ({
  readArticlesFromDisk: () => structuredClone(state.draft?.articles ?? []),
  readNavigationFromDisk: () => structuredClone(state.draft?.navigation ?? []),
  readSiteSettingsFromDisk: () => structuredClone(state.draft?.settings ?? { ...DEFAULT_SITE_SETTINGS }),
  getEditorDataResourceManifest: (_resource: string, value: unknown) => ({ revision: JSON.stringify(value) }),
}));

vi.mock('@/lib/jobs/watermark', () => ({
  readBackupWatermarkUnderLock: () => structuredClone(state.watermark),
}));

vi.mock('@/lib/jobs/store', () => ({
  listJobsUnderLock: () => state.jobs,
  createOrReuseActiveJobUnderLock: (_root: string, input: { type: string; id: string; input: unknown }) => {
    const existing = state.jobs.find((job) => job.id === input.id);
    if (existing) return existing;
    const job = { id: input.id, type: input.type, input: input.input, status: 'pending' as const };
    state.jobs.push(job);
    return job;
  },
}));

vi.mock('@/lib/publishing/store', () => ({
  readLivePointer: () => state.pointer,
  readRelease: () => ({ release: structuredClone(state.release), snapshot: structuredClone(state.snapshot) }),
  writeRelease: (release: ReleaseRecord) => {
    state.release = structuredClone(release);
    const retryInput = { releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest, retry: true, retryFromAttempt: release.retryFromAttempt };
    if (release.retryFromAttempt !== null && release.error?.code === 'RETRY_PENDING'
        && !state.jobs.some((job) => JSON.stringify(job.input) === JSON.stringify(retryInput))) {
      state.jobs.push({ id: `publish-${release.id}-retry-${release.retryFromAttempt}`, type: 'publish', input: retryInput, status: 'pending' });
    }
  },
}));

vi.mock('@/lib/runtime-config', () => ({ getRuntimeDataRootPath: () => os.tmpdir() }));
vi.mock('@/lib/runtime-data-lock', () => ({ withRuntimeDataRootLock: async (operation: () => unknown) => {
  state.contentLockDepth += 1;
  try { return await operation(); } finally { state.contentLockDepth -= 1; }
} }));

import { createEditorReleaseRetryService } from '@/lib/editor-runtime/retry-runtime';

const initialSnapshot: SiteSnapshot = {
  schemaVersion: 1, siteId: 'site', articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
  media: [], redirects: [], removedPaths: [],
};

function makeRelease(): ReleaseRecord {
  return {
    schemaVersion: 1,
    id: 'release-1',
    scope: { kind: 'settings' },
    baseLiveReleaseId: null,
    selectedRevision: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    artifactDigest: 'c'.repeat(64),
    status: 'failed',
    backupProof: { repository: 'owner/backup', commitSha: 'd'.repeat(40), snapshotId: 'proof-1', contentDigest: 'e'.repeat(64), candidateDigest: 'b'.repeat(64), verifiedAt: '2026-10-01T00:00:00.000Z' },
    publicCommitSha: 'f'.repeat(40),
    workflowRunId: 71,
    workflowRunAttempt: 1,
    retryFromAttempt: null,
    error: { code: 'DEPLOY_FAILED', message: 'failed', retryable: true },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function setup() {
  state.manifestIdentity = { releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64) };
  state.sealedTreeValid = true;
  state.runnerCalls = 0;
  state.rootLookups = 0;
  state.sealedTreeIdentity = null;
  state.release = makeRelease();
  state.snapshot = structuredClone(initialSnapshot);
  state.draft = structuredClone(initialSnapshot);
  state.manifestIdentity = { releaseId: 'release-1', candidateDigest: computeCandidateDigest(initialSnapshot), artifactDigest: 'c'.repeat(64) };
  state.release!.candidateDigest = computeCandidateDigest(initialSnapshot);
  state.release!.selectedRevision = computeSelectedRevision({ scope: state.release!.scope, generation: state.watermark.generation, selectedInputs: { settings: initialSnapshot.settings }, media: initialSnapshot.media });
  state.release!.backupProof!.candidateDigest = state.release!.candidateDigest;
  state.pointer = null;
  state.jobs = [{ id: 'publish-release-1', type: 'publish', input: { releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64) }, status: 'succeeded' }];
  state.currentAttempt = 1;
  state.reruns = 0;
  state.artifactVerifications = 0;
  state.contentLockDepth = 0;
  state.verifyLockDepths = [];
  state.afterArtifactVerification = null;
    state.headCommit = 'f'.repeat(40);
    state.lastRunQuery = null;
    state.lastRunQueries = [];
    state.lastBranchQuery = '';
  }


afterEach(() => {
  vi.clearAllMocks();
});

describe('production editor release retry adapter', () => {
  it('uses current selected resource inputs and rejects changed candidate selection', async () => {
    setup();
    state.draft!.settings = { ...state.draft!.settings, siteName: 'Changed after release' };
    const service = await createEditorReleaseRetryService();

    await expect(service.retry('release-1')).rejects.toMatchObject({ status: 409, code: 'RETRY_CONFLICT' });
    expect(state.release?.status).toBe('failed');
    expect(state.jobs).toHaveLength(1);
  });

  it('persists a distinct retry job with the exact retry round identity and resumes it', async () => {
    setup();
    state.headCommit = 'f'.repeat(40);
    const service = await createEditorReleaseRetryService();

    await service.retry('release-1');

    const retryJob = state.jobs.find((job) => (job.input as { retry?: boolean } | null)?.retry === true);
    expect(retryJob).toMatchObject({
      id: 'publish-release-1-retry-1',
      type: 'publish',
      input: {
        releaseId: 'release-1',
        candidateDigest: computeCandidateDigest(initialSnapshot),
        artifactDigest: 'c'.repeat(64),
        retry: true,
        retryFromAttempt: 1,
      },
    });
    expect(state.jobs[0].id).toBe('publish-release-1');
    expect(state.jobs).toHaveLength(2);
    const resumed = await service.resume('release-1');
    expect(resumed?.id).toBe(retryJob?.id);
    expect(state.reruns).toBe(0);
  });

  it('rejects a tampered sealed artifact tree before authorizing retry', async () => {
    setup();
    state.sealedTreeValid = false;
    const service = await createEditorReleaseRetryService();

    await expect(service.retry('release-1')).rejects.toMatchObject({ status: 503, code: 'BACKUP_REQUIRED' });
    expect(state.release?.status).toBe('failed');
    expect(state.jobs).toHaveLength(2);
    expect(state.reruns).toBe(0);
    expect(state.artifactVerifications).toBe(1);
    expect(state.verifyLockDepths).toEqual([0]);
    expect(state.runnerCalls).toBe(1);
    expect(state.rootLookups).toBe(1);
  });

  it('keeps artifact tree verification outside the content lock before retry POST', async () => {
    setup();
    const service = await createEditorReleaseRetryService();
    await service.retry('release-1');
    expect(state.reruns).toBe(0);
    expect(state.artifactVerifications).toBe(1);
    expect(state.verifyLockDepths).toEqual([0]);
  });

  it('rejects a sealed manifest identity that differs from release and frozen snapshot', async () => {
    setup();
    state.manifestIdentity = { releaseId: 'release-1', candidateDigest: '0'.repeat(64), artifactDigest: 'c'.repeat(64) };
    const service = await createEditorReleaseRetryService();

    await expect(service.retry('release-1')).rejects.toMatchObject({ status: 503, code: 'BACKUP_REQUIRED' });
    expect(state.release?.status).toBe('failed');
  });

  it('uses configured Pages branch and workflow for retry preconditions and attempt lookup', async () => {
    setup();
    process.env.BLOG_PAGES_BRANCH = 'production';
    process.env.BLOG_PAGES_WORKFLOW = 'pages-release.yml';
    const service = await createEditorReleaseRetryService();

    await service.retry('release-1');
    expect(state.release?.status).toBe('verifying');
    expect(state.lastBranchQuery).toBe('production');
    expect(state.lastRunQueries).toEqual([]);
    expect(state.reruns).toBe(0);

    delete process.env.BLOG_PAGES_BRANCH;
    delete process.env.BLOG_PAGES_WORKFLOW;
  });
});
