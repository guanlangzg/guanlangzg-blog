import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubRestClient } from '@/lib/github/client';
import { createPagesJobHandlers, createProductionPagesJobRuntime } from '@/lib/editor-runtime/pages-runtime';
import { createPublishingGitHubRuntime, type PublishingGitHubRuntime } from '@/lib/editor-runtime/github-runtime';
import { createEditorReleaseRetryService } from '@/lib/editor-runtime/retry-runtime';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { readLivePointer, readRelease, writeLivePointer, writeRelease } from '@/lib/publishing/store';
import { claimNextJob, completeClaimedJob, listJobs } from '@/lib/jobs/store';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

vi.mock('@/lib/editor-runtime/github-runtime', () => ({ createPublishingGitHubRuntime: vi.fn() }));
vi.mock('@/lib/editor-runtime/retry-runtime', () => ({ createEditorReleaseRetryService: vi.fn() }));

const workflow = 'name: Test Pages workflow\n';
const convention = 'site-subtree-v1|release-marker-v1|force-false\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const snapshot: SiteSnapshot = {
  schemaVersion: 1, siteId: 'test-site', articles: [], navigation: [],
  settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
};
function releaseRecord(): ReleaseRecord {
  return {
    schemaVersion: 1, id: 'release-runtime', scope: { kind: 'bootstrap', articleIds: [] },
    baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest: computeCandidateDigest(snapshot),
    artifactDigest: 'b'.repeat(64), status: 'publishing', backupProof: null,
    publicCommitSha: null, workflowRunId: null, workflowRunAttempt: null,
    retryFromAttempt: null, error: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function githubRuntime(remoteConvention: string | null = convention, truncated = false, pagesUrl = 'https://test-site.invalid/blog/'): PublishingGitHubRuntime {
  const client = new GitHubRestClient({
    repositories: {
      source: { id: 3, owner: 'test-owner', name: 'test-source' },
      pages: { id: 1, owner: 'test-owner', name: 'test-pages' },
      backup: { id: 2, owner: 'test-owner', name: 'test-backup' },
    },
    tokenProvider: { getToken: async () => 'test-only-token' },
    fetch: async (url, options) => {
      expect(options?.method).toBe('GET');
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/repos/test-owner/test-pages/pages')) return Response.json({ url: pagesUrl, html_url: pagesUrl, source: { branch: 'main', path: '/' }, status: 'built' });
      if (pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'c'.repeat(40) } });
      if (pathname.endsWith(`/git/commits/${'c'.repeat(40)}`)) return Response.json({ tree: { sha: 'd'.repeat(40) } });
      if (pathname.endsWith(`/git/trees/${'d'.repeat(40)}`)) return Response.json({ truncated, tree: [
        { path: '.github/workflows/deploy.yml', type: 'blob', sha: 'e'.repeat(40) },
        ...(remoteConvention === null ? [] : [{ path: '.github/pages-managed.txt', type: 'blob', sha: 'f'.repeat(40) }]),
      ] });
      if (pathname.endsWith(`/git/blobs/${'e'.repeat(40)}`)) return Response.json({ encoding: 'base64', content: Buffer.from(workflow).toString('base64') });
      if (pathname.endsWith(`/git/blobs/${'f'.repeat(40)}`)) return Response.json({ encoding: 'base64', content: Buffer.from(remoteConvention ?? '').toString('base64') });
      throw new Error('Unexpected GitHub request in isolated test.');
    },
  });
  return {
    prepareClient: async () => client,
    readHistoryApiOptions: () => { throw new Error('History is not part of this test.'); },
    listRunsByHeadSha: async () => [{ id: 71, runAttempt: 2, headSha: 'c'.repeat(40), branch: 'main', workflow: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success' }],
    getAttemptWithJobs: async () => ({
      runId: 71, runAttempt: 2, headSha: 'c'.repeat(40), branch: 'main', workflow: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success',
      jobs: [{ name: 'deploy', status: 'completed', conclusion: 'success', steps: [{ name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'success' }] }],
    }),
    rerunRun: async () => { throw new Error('Rerun is not part of this test.'); },
    getPagesHeadCommitSha: async () => 'c'.repeat(40),
    getPagesSiteUrl: async () => pagesUrl,
  };
}

function retryServiceStub(resume: (releaseId: string) => Promise<null>): Awaited<ReturnType<typeof createEditorReleaseRetryService>> {
  return {
    retry: async () => { throw new Error('Retry creation is not part of this test.'); },
    resume,
    recordVerificationOutcome: async <T>(_: string, verify: () => Promise<T>): Promise<T | 'pending_verification'> => verify(),
  };
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-pages-runtime-'));
  roots.push(root);
  vi.stubEnv('BLOG_DATA_ROOT', root);
  vi.stubEnv('BLOG_PAGES_WORKFLOW_DIGEST', digest(workflow));
  vi.stubEnv('BLOG_PAGES_MANAGED_CONVENTION_DIGEST', digest(convention));
  vi.stubEnv('BLOG_PAGES_URL', 'https://test-site.invalid/blog/');
  vi.mocked(createPublishingGitHubRuntime).mockResolvedValue(githubRuntime());
  vi.mocked(createEditorReleaseRetryService).mockResolvedValue(retryServiceStub(async () => null));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('production Pages runtime with isolated GitHub transport', () => {
  it.each([['changed', 'changed convention\n'], ['missing', null]] as const)(
    'refuses a %s remote managed convention before reading or submitting artifacts', async (_label, remoteConvention) => {
      vi.mocked(createPublishingGitHubRuntime).mockResolvedValue(githubRuntime(remoteConvention));
      const runtime = (await createProductionPagesJobRuntime())!;
      const release = releaseRecord();
      writeRelease(release, snapshot);

      await expect(runtime.commit({ release, snapshot })).rejects.toMatchObject({ code: 'PAGES_CONFLICT', status: 409 });
      expect(readRelease(release.id).release.publicCommitSha).toBeNull();
      expect(readLivePointer()).toBeNull();
    },
  );

  it('refuses a truncated remote tree instead of treating an incomplete convention as verified', async () => {
    vi.mocked(createPublishingGitHubRuntime).mockResolvedValue(githubRuntime(convention, true));
    const runtime = (await createProductionPagesJobRuntime())!;
    const release = releaseRecord();
    writeRelease(release, snapshot);

    await expect(runtime.commit({ release, snapshot })).rejects.toThrow(/truncated|incomplete/i);
    expect(readRelease(release.id).release.publicCommitSha).toBeNull();
  });

  it.each(['wrong branch', 'wrong workflow', 'wrong run id'])('keeps %s attempt evidence pending without changing live', async (mismatch) => {
    const github = githubRuntime();
    const correct = await github.getAttemptWithJobs(71, 2);
    github.getAttemptWithJobs = async () => ({
      ...correct,
      ...(mismatch === 'wrong branch' ? { branch: 'untrusted-branch' } : {}),
      ...(mismatch === 'wrong workflow' ? { workflow: '.github/elsewhere/deploy.yml' } : {}),
      ...(mismatch === 'wrong run id' ? { runId: 72 } : {}),
    });
    vi.mocked(createPublishingGitHubRuntime).mockResolvedValue(github);
    const release = { ...releaseRecord(), status: 'verifying' as const, publicCommitSha: 'c'.repeat(40), workflowRunId: 71, workflowRunAttempt: 2 };
    writeRelease(release, snapshot);
    vi.stubGlobal('fetch', async () => Response.json({ releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest }));
    const runtime = (await createProductionPagesJobRuntime())!;
    const result = await runtime.verifyAndPromote({
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest!,
      publicCommitSha: release.publicCommitSha, workflowRunId: 71, workflowRunAttempt: 2, branch: 'main', workflow: 'deploy.yml',
    });
    expect(result.kind).toBe('pending_verification');
    expect(readLivePointer()).toBeNull();
    expect(readRelease(release.id).release.status).toBe('verifying');
  });

  it('refuses to verify a marker from a URL that does not belong to the configured GitHub Pages site', async () => {
    vi.stubEnv('BLOG_PAGES_URL', 'https://wrong-site.invalid/blog');
    vi.mocked(createPublishingGitHubRuntime).mockResolvedValue(githubRuntime(convention, false, 'https://test-site.invalid/blog'));
    const release = { ...releaseRecord(), status: 'verifying' as const, publicCommitSha: 'c'.repeat(40), workflowRunId: 71, workflowRunAttempt: 2 };
    writeRelease(release, snapshot);
    let markerRequests = 0;
    vi.stubGlobal('fetch', async () => {
      markerRequests += 1;
      return Response.json({ releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest });
    });
    const runtime = (await createProductionPagesJobRuntime())!;

    const result = await runtime.verifyAndPromote({
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest!,
      publicCommitSha: release.publicCommitSha, workflowRunId: 71, workflowRunAttempt: 2, branch: 'main', workflow: 'deploy.yml',
    });

    expect(result.kind).toBe('failed');
    expect(markerRequests).toBe(0);
    expect(readLivePointer()).toBeNull();
  });

  it('persists reconcile identity with the sealed artifact digest', async () => {
    const release = { ...releaseRecord(), status: 'deploying' as const, publicCommitSha: 'c'.repeat(40) };
    writeRelease(release, snapshot);
    const runtime = (await createProductionPagesJobRuntime())!;
    await runtime.enqueueReconcile(release.id, release.candidateDigest, release.artifactDigest!);
    const jobs = await listJobs();
    expect(jobs.filter((job) => job.type === 'reconcile').map((job) => job.input)).toEqual([{
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }]);
  });

  it('does not verify an older reconcile job without a persisted artifact digest', async () => {
    const release = { ...releaseRecord(), status: 'verifying' as const, publicCommitSha: 'c'.repeat(40), workflowRunId: 71, workflowRunAttempt: 2 };
    writeRelease(release, snapshot);
    const handlers = (await createPagesJobHandlers({ runtime: (await createProductionPagesJobRuntime())! }))!;
    expect(await handlers.reconcile({
      id: 'old-reconcile', type: 'reconcile', inputDigest: 'old',
      input: { releaseId: release.id, candidateDigest: release.candidateDigest },
      status: 'running', attempt: 1, nextAttemptAt: '2026-10-01T00:00:00.000Z',
      claimedAt: '2026-10-01T00:00:00.000Z', remoteCommit: null, lastError: null,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    })).toMatchObject({ blocked: { message: expect.stringContaining('identity') } });
    expect(readLivePointer()).toBeNull();
  });

  it('resumes an authorized retry in production before reconciling its new workflow attempt', async () => {
    const release = {
      ...releaseRecord(), status: 'deploying' as const, publicCommitSha: 'c'.repeat(40),
      workflowRunId: 71, workflowRunAttempt: 1, retryFromAttempt: 1,
      error: { code: 'RETRY_POSTING', message: 'attempt pending', retryable: true },
    };
    writeRelease(release, snapshot);
    const resumedRounds: string[] = [];
    vi.mocked(createEditorReleaseRetryService).mockResolvedValue(retryServiceStub(async (releaseId) => {
      resumedRounds.push(releaseId);
      writeRelease({ ...readRelease(releaseId).release, workflowRunAttempt: 2, error: null }, snapshot);
      return null;
    }));
    const handlers = (await createPagesJobHandlers())!;
    const result = await handlers.publish({
      id: 'retry-job', type: 'publish', inputDigest: 'retry',
      input: {
        releaseId: release.id, candidateDigest: release.candidateDigest,
        artifactDigest: release.artifactDigest, retry: true, retryFromAttempt: 1,
      },
      status: 'running', attempt: 1, nextAttemptAt: '2026-10-01T00:00:00.000Z',
      claimedAt: '2026-10-01T00:00:00.000Z', remoteCommit: null, lastError: null,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(resumedRounds).toEqual([release.id]);
    expect(result).toMatchObject({ defer: { message: expect.stringContaining('retry') } });
    expect((await listJobs()).filter((job) => job.type === 'reconcile').map((job) => job.input)).toEqual([{
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }]);
    expect(readRelease(release.id).release.workflowRunAttempt).toBe(2);
  });

  it('does not requeue a completed pointer backup on a repeated exact live verification', async () => {
    const release = { ...releaseRecord(), status: 'verifying' as const, publicCommitSha: 'c'.repeat(40), workflowRunId: 71, workflowRunAttempt: 2 };
    writeRelease(release, snapshot);
    writeLivePointer({
      schemaVersion: 1, releaseId: release.id, candidateDigest: release.candidateDigest,
      artifactDigest: release.artifactDigest!, publicCommitSha: release.publicCommitSha,
      workflowRunId: 71, workflowRunAttempt: 2, verifiedAt: '2026-10-01T00:00:00.000Z',
    });
    vi.stubGlobal('fetch', async () => Response.json({ releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest }));
    const runtime = (await createProductionPagesJobRuntime())!;
    const identity = {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest!,
      publicCommitSha: release.publicCommitSha, workflowRunId: 71, workflowRunAttempt: 2, branch: 'main', workflow: 'deploy.yml',
    };
    expect((await runtime.verifyAndPromote(identity)).kind).toBe('live');
    const backup = (await claimNextJob({ types: ['backup'] }))!;
    await completeClaimedJob(backup.id, backup.claimToken);
    expect((await runtime.verifyAndPromote(identity)).kind).toBe('live');
    expect((await listJobs()).filter((job) => job.type === 'backup')).toHaveLength(1);
  });

  it('reads the marker from the configured Pages base path without caching before promoting live', async () => {
    const release = { ...releaseRecord(), status: 'verifying' as const, publicCommitSha: 'c'.repeat(40), workflowRunId: 71, workflowRunAttempt: 2 };
    writeRelease(release, snapshot);
    const requests: Array<{ url: string; cache: RequestCache | undefined }> = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      requests.push({ url: String(url), cache: options.cache });
      return Response.json({ releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest });
    });
    const runtime = (await createProductionPagesJobRuntime())!;

    const result = await runtime.verifyAndPromote({
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest!,
      publicCommitSha: release.publicCommitSha, workflowRunId: 71, workflowRunAttempt: 2, branch: 'main', workflow: 'deploy.yml',
    });

    expect(result.kind).toBe('live');
    expect(requests).toEqual([{ url: 'https://test-site.invalid/blog/_release.json', cache: 'no-store' }]);
    expect(readLivePointer()).toMatchObject({ releaseId: release.id, publicCommitSha: release.publicCommitSha, workflowRunAttempt: 2 });
    expect(readRelease(release.id).release.status).toBe('live');
  });
});
