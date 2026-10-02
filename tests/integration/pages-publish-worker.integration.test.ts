import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { createPagesJobHandlers, type PagesJobRuntime } from '@/lib/editor-runtime/pages-runtime';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import type { JobRecord } from '@/lib/jobs/store';

const snapshot: SiteSnapshot = {
  schemaVersion: 1,
  siteId: 'site',
  articles: [],
  navigation: [],
  settings: { ...DEFAULT_SITE_SETTINGS },
  media: [],
  redirects: [],
  removedPaths: [],
};

const release: ReleaseRecord = {
  schemaVersion: 1,
  id: 'release-1',
  scope: { kind: 'bootstrap', articleIds: [] },
  baseLiveReleaseId: null,
  selectedRevision: 'a'.repeat(64),
  candidateDigest: computeCandidateDigest(snapshot),
  artifactDigest: 'c'.repeat(64),
  status: 'publishing',
  backupProof: null,
  publicCommitSha: null,
  workflowRunId: null,
  workflowRunAttempt: null,
  retryFromAttempt: null,
  error: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

function job(type: 'publish' | 'reconcile', input: unknown): JobRecord {
  return {
    id: `${type}-job`,
    type,
    inputDigest: 'digest',
    input,
    status: 'running',
    attempt: 1,
    nextAttemptAt: '2026-09-30T00:00:00.000Z',
    claimedAt: '2026-09-30T00:00:00.000Z',
    claimToken: 'claim',
    remoteCommit: null,
    lastError: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

function runtime(overrides: Partial<PagesJobRuntime> = {}): PagesJobRuntime {
  return {
    branch: 'main',
    workflow: 'deploy.yml',
    workflowPath: '.github/workflows/deploy.yml',
    expectedWorkflowDigest: 'workflow-digest',
    expectedManagedConventionDigest: 'convention-digest',
    readRelease: async () => ({ release: structuredClone(release), snapshot: structuredClone(snapshot) }),
    commit: async () => undefined,
    captureWorkflowRun: async () => null,
    verifyAndPromote: async () => ({ kind: 'pending_verification', message: 'pending' }),
    enqueueReconcile: async () => undefined,
    ...overrides,
  };
}

describe('Pages publish and reconcile jobs', () => {
  it('blocks a legacy publishing task when no sealed artifact digest was authorized', async () => {
    let commits = 0;
    const handlers = (await createPagesJobHandlers({ runtime: runtime({ commit: async () => { commits += 1; } }) }))!;
    expect(await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest,
    }))).toMatchObject({ blocked: { message: expect.stringContaining('identity') } });
    expect(commits).toBe(0);
  });

  it('rejects an altered artifact digest before the publishing worker submits sealed bytes', async () => {
    let commitCalls = 0;
    const handlers = (await createPagesJobHandlers({ runtime: runtime({ commit: async () => { commitCalls += 1; } }) }))!;
    await expect(handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: 'f'.repeat(64),
    }))).rejects.toThrow(/artifact digest/i);
    expect(commitCalls).toBe(0);
  });

  it('reconciles a release marked live after the pointer transaction was interrupted', async () => {
    let verified = 0;
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({ release: {
          ...release, status: 'live', publicCommitSha: 'e'.repeat(40), workflowRunId: 44, workflowRunAttempt: 2,
        }, snapshot }),
        verifyAndPromote: async () => { verified += 1; return { kind: 'live', verifiedAt: '2026-10-01T00:00:00.000Z' }; },
      }),
    }))!;
    await handlers.reconcile(job('reconcile', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }));
    expect(verified).toBe(1);
  });

  it('holds an already authorized retry task for its resume handler rather than submitting a new commit', async () => {
    let commits = 0;
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({ release: {
          ...release, status: 'deploying', publicCommitSha: 'e'.repeat(40), retryFromAttempt: 1,
          workflowRunId: 44, workflowRunAttempt: 1,
        }, snapshot }),
        commit: async () => { commits += 1; },
        resumeRetry: async () => undefined,
      }),
    }))!;
    const result = await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
      retry: true, retryFromAttempt: 1,
    }));
    expect(commits).toBe(0);
    expect(result).toMatchObject({ defer: { message: expect.stringContaining('retry') } });
  });

  it('blocks a retry task if no resume handler is registered', async () => {
    const handlers = (await createPagesJobHandlers({ runtime: runtime({
      readRelease: async () => ({ release: {
        ...release, status: 'deploying', publicCommitSha: 'e'.repeat(40), retryFromAttempt: 1,
        workflowRunId: 44, workflowRunAttempt: 1,
      }, snapshot }),
    }) }))!;
    expect(await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
      retry: true, retryFromAttempt: 1,
    }))).toMatchObject({ blocked: { message: expect.stringContaining('handler') } });
  });

  it('resumes an authorized retry and queues verification only after its new attempt is persisted', async () => {
    let commits = 0;
    let resumes = 0;
    const queued: string[] = [];
    let current = {
      ...release, status: 'deploying' as const, publicCommitSha: 'e'.repeat(40), retryFromAttempt: 1,
      workflowRunId: 44, workflowRunAttempt: 1,
    };
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({ release: current, snapshot }),
        commit: async () => { commits += 1; },
        resumeRetry: async () => { resumes += 1; current = { ...current, workflowRunAttempt: 2 }; },
        enqueueReconcile: async (_id, _candidate, artifact) => { queued.push(artifact); },
      }),
    }))!;
    const result = await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
      retry: true, retryFromAttempt: 1,
    }));
    expect(commits).toBe(0);
    expect(resumes).toBe(1);
    expect(queued).toEqual([release.artifactDigest]);
    expect(result).toMatchObject({ defer: { message: expect.stringContaining('retry') } });
  });

  it('does not reverify the failed attempt while a retry POST is unresolved', async () => {
    let verified = 0;
    const handlers = (await createPagesJobHandlers({ runtime: runtime({
      readRelease: async () => ({ release: {
        ...release, status: 'deploying', publicCommitSha: 'e'.repeat(40), workflowRunId: 44,
        workflowRunAttempt: 1, retryFromAttempt: 1,
        error: { code: 'RETRY_POSTING', message: 'unknown response', retryable: true },
      }, snapshot }),
      verifyAndPromote: async () => { verified += 1; return { kind: 'failed', code: 'DEPLOYMENT_FAILED', message: 'old attempt' }; },
    }) }))!;
    expect(await handlers.reconcile(job('reconcile', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }))).toMatchObject({ defer: { message: expect.stringContaining('retry') } });
    expect(verified).toBe(0);
  });

  it('terminates a retry task after its new attempt failed conclusively', async () => {
    const handlers = (await createPagesJobHandlers({ runtime: runtime({
      readRelease: async () => ({ release: {
        ...release, status: 'failed', publicCommitSha: 'e'.repeat(40), workflowRunId: 44,
        workflowRunAttempt: 2, retryFromAttempt: 1,
        error: { code: 'DEPLOYMENT_FAILED', message: 'deployment failed', retryable: true },
      }, snapshot }),
    }) }))!;
    expect(await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
      retry: true, retryFromAttempt: 1,
    }))).toMatchObject({ blocked: { message: expect.stringContaining('failed') } });
  });

  it('marks the reconcile task failed when the exact deployment fails', async () => {
    const handlers = (await createPagesJobHandlers({ runtime: runtime({
      readRelease: async () => ({ release: {
        ...release, status: 'verifying', publicCommitSha: 'e'.repeat(40),
        workflowRunId: 44, workflowRunAttempt: 2,
      }, snapshot }),
      verifyAndPromote: async () => ({ kind: 'failed', code: 'DEPLOYMENT_FAILED', message: 'The deployment failed.' }),
    }) }))!;
    expect(await handlers.reconcile(job('reconcile', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }))).toMatchObject({ blocked: { message: expect.stringContaining('failed') } });
  });

  it('does not recapture a failed release when an older publish task resumes', async () => {
    let runLookups = 0;
    const handlers = (await createPagesJobHandlers({ runtime: runtime({
      readRelease: async () => ({ release: {
        ...release, status: 'failed', publicCommitSha: 'e'.repeat(40),
        workflowRunId: 44, workflowRunAttempt: 2,
      }, snapshot }),
      captureWorkflowRun: async () => { runLookups += 1; return null; },
    }) }))!;
    expect(await handlers.publish(job('publish', {
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest,
    }))).toMatchObject({ blocked: { message: expect.stringContaining('failed') } });
    expect(runLookups).toBe(0);
  });

  it('commits the frozen release once and queues reconcile without claiming live', async () => {
    let commitCalls = 0;
    let reconcileCalls = 0;
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        commit: async (input) => {
          commitCalls += 1;
          expect(input.release.id).toBe('release-1');
          expect(input.release.candidateDigest).toBe(release.candidateDigest);
          expect(input.snapshot).toEqual(snapshot);
        },
        enqueueReconcile: async (releaseId, candidateDigest) => {
          reconcileCalls += 1;
          expect(releaseId).toBe('release-1');
          expect(candidateDigest).toBe(release.candidateDigest);
        },
      }),
    }))!;

    const result = await handlers.publish(job('publish', { releaseId: 'release-1', candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest }));

    expect(result).toBeUndefined();
    expect(commitCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  });

  it('keeps reconcile pending when the exact deployment run is not visible', async () => {
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({
          release: { ...release, status: 'deploying', publicCommitSha: 'e'.repeat(40) },
          snapshot,
        }),
        captureWorkflowRun: async () => null,
      }),
    }))!;

    const result = await handlers.reconcile(job('reconcile', { releaseId: 'release-1', candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest }));

    expect(result).toMatchObject({ defer: { message: expect.stringContaining('pending') } });
  });

  it('does not submit a release whose persisted candidate digest no longer matches the job', async () => {
    let commitCalls = 0;
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({ release: { ...release, candidateDigest: 'd'.repeat(64) }, snapshot }),
        commit: async () => { commitCalls += 1; },
      }),
    }))!;

    await expect(handlers.publish(job('publish', { releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: release.artifactDigest })))
      .rejects.toThrow(/candidate digest/i);
    expect(commitCalls).toBe(0);
  });

  it('promotes only after the persisted exact run and attempt are verified', async () => {
    let verifyCalls = 0;
    const handlers = (await createPagesJobHandlers({
      runtime: runtime({
        readRelease: async () => ({
          release: {
            ...release,
            status: 'verifying',
            publicCommitSha: 'e'.repeat(40),
            workflowRunId: 44,
            workflowRunAttempt: 2,
          },
          snapshot,
        }),
        verifyAndPromote: async (identity) => {
          verifyCalls += 1;
          expect(identity).toMatchObject({
            releaseId: 'release-1',
            candidateDigest: computeCandidateDigest(snapshot),
            artifactDigest: 'c'.repeat(64),
            publicCommitSha: 'e'.repeat(40),
            workflowRunId: 44,
            workflowRunAttempt: 2,
          });
          return { kind: 'live', verifiedAt: '2026-09-30T00:01:00.000Z' };
        },
      }),
    }))!;

    const result = await handlers.reconcile(job('reconcile', { releaseId: 'release-1', candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest }));

    expect(result).toBeUndefined();
    expect(verifyCalls).toBe(1);
  });
});
