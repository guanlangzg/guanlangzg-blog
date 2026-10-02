import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { createReleaseRetryService, type RetryAdapter } from '@/lib/publishing/retry';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const release: ReleaseRecord = {
  schemaVersion: 1,
  id: 'release-1', scope: { kind: 'article', articleId: 'a', action: 'publish' },
  baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest: 'b'.repeat(64),
  artifactDigest: 'c'.repeat(64), status: 'failed',
  backupProof: { repository: 'owner/backup', commitSha: 'd'.repeat(40), snapshotId: 'snap', contentDigest: 'e'.repeat(64), candidateDigest: 'b'.repeat(64), verifiedAt: '2026-09-30T00:00:00.000Z' },
  publicCommitSha: 'f'.repeat(40), workflowRunId: 71, workflowRunAttempt: 1, retryFromAttempt: null,
  error: { code: 'DEPLOY_FAILED', message: 'deployment failed', retryable: true },
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
};
const snapshot: SiteSnapshot = {
  schemaVersion: 1, siteId: 'site', articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
  media: [], redirects: [], removedPaths: [],
};

function fixture(remotePreconditionsPass = true) {
  let current = structuredClone(release);
  let tasks: Array<{ id: string; releaseId: string; status: 'pending' }> = [];
  let postCalls = 0;
  let lookups = 0;
  let currentAttempt = 1;
  let remoteChecks = 0;
  let blockLatestAttempt = false;
  let latestAttemptStarted: (() => void) | null = null;
  let latestAttemptWait: Promise<void> | null = null;
  let latestAttemptArrivals = 0;
  let expectedLatestAttemptArrivals = 1;
  let latestAttemptObservationsReady: (() => void) | null = null;
  let latestAttemptObservationsWait: Promise<void> | null = null;
  let observedLatestAttempts = 0;
  let postFailures = 0;
  let verification: 'live' | 'failed' | 'pending_verification' = 'pending_verification';
  let artifactTreeValid = true;
  let verificationGate: Promise<void> | null = null;
  let verificationStarted: (() => void) | null = null;
  let lockQueue: Promise<void> = Promise.resolve();
  const adapter: RetryAdapter = {
    withContentLock: async (operation) => {
      let unlock!: () => void;
      const previous = lockQueue;
      lockQueue = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      try {
        return await operation({
          readRelease: () => ({ release: structuredClone(current), snapshot: structuredClone(snapshot) }),
          writeRelease: (next) => { current = structuredClone(next); },
          readLiveReleaseId: () => null,
          readInputs: () => ({ selectedRevision: current.selectedRevision, baseLiveReleaseId: null }),
          readWatermark: () => ({ generation: 'g', contentSequence: 3, backedUpThrough: 3, blockedReason: null }),
          isBackupProofValid: () => true,
          verifyArtifactIdentity: () => true,
          persistPublishTask: (next) => {
            current = structuredClone(next);
            const persisted = { id: `task-publish-${current.retryFromAttempt ?? 'initial'}`, releaseId: current.id, status: 'pending' as const };
            tasks.push(persisted);
            return persisted;
          },
          findPublishTask: (releaseId) => tasks.find((item) => item.releaseId === releaseId && item.id.endsWith(`-${current.retryFromAttempt ?? 'initial'}`)) ?? null,
        });
      } finally {
        unlock();
      }
    },
      verifyArtifactTree: async () => {
        verificationStarted?.();
        if (verificationGate) await verificationGate;
        return artifactTreeValid && current.artifactDigest
          ? { releaseId: current.id, candidateDigest: current.candidateDigest, artifactDigest: current.artifactDigest }
          : null;
      },
      verifyRetryPreconditions: async () => { remoteChecks += 1; return remotePreconditionsPass; },
      getLatestAttempt: async () => {
        lookups += 1;
        const observedAttempt = currentAttempt;
        if (blockLatestAttempt && latestAttemptStarted && latestAttemptWait) {
          latestAttemptArrivals += 1;
          if (latestAttemptArrivals === expectedLatestAttemptArrivals) latestAttemptStarted();
          await latestAttemptWait;
          observedLatestAttempts += 1;
          if (observedLatestAttempts === expectedLatestAttemptArrivals) latestAttemptObservationsReady?.();
          await latestAttemptObservationsWait;
        }
        return observedAttempt;
      },
    rerunWorkflow: async (runId) => {
      expect(runId).toBe(71);
      postCalls += 1;
      if (postFailures > 0) { postFailures -= 1; throw new Error('response lost'); }
      currentAttempt += 1;
    },
  };
  const service = createReleaseRetryService({
    adapter,
    verifyDeployment: async () => verification === 'live'
      ? { kind: 'live', verifiedAt: '2026-09-30T01:00:00.000Z' }
      : verification === 'failed'
        ? { kind: 'failed', code: 'DEPLOYMENT_FAILED', message: 'failed again' }
        : { kind: 'pending_verification', message: 'pending' },
    now: () => '2026-09-30T00:00:00.000Z',
  });
  return {
    service, state: () => current, task: () => tasks.at(-1) ?? null,
    counts: () => ({ postCalls, lookups, remoteChecks }),
    setAttempt: (attempt: number) => { currentAttempt = attempt; },
    setPostFailures: (count: number) => { postFailures = count; },
    blockArtifactVerification: () => {
      let start!: () => void;
      let unblock!: () => void;
      const started = new Promise<void>((resolve) => { start = resolve; });
      verificationGate = new Promise<void>((resolve) => { unblock = resolve; });
      verificationStarted = start;
      return { started, unblock };
    },
    setVerification: (result: typeof verification) => { verification = result; },
    blockAttemptReads: (concurrentReads = 1) => {
      blockLatestAttempt = true;
      expectedLatestAttemptArrivals = concurrentReads;
      let started!: () => void;
      let release!: () => void;
      let observationsReady!: () => void;
      let releaseObservations!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const observations = new Promise<void>((resolve) => { observationsReady = resolve; });
      latestAttemptWait = new Promise<void>((resolve) => { release = resolve; });
      latestAttemptObservationsWait = new Promise<void>((resolve) => { releaseObservations = resolve; });
      latestAttemptObservationsReady = observationsReady;
      latestAttemptStarted = started;
      return { entered, release, observations, releaseObservations };
    },
  };
}

describe('release recovery', () => {
  it('reruns the same run once, persists its new attempt, and duplicate requests return the same task', async () => {
    const test = fixture();
    const first = await test.service.retry('release-1');
    const duplicate = await test.service.retry('release-1');
    expect(test.counts()).toEqual({ postCalls: 1, lookups: 3, remoteChecks: 1 });
    expect(test.state()).toMatchObject({ retryFromAttempt: 1, workflowRunAttempt: 2, status: 'verifying' });
    expect(first).toEqual(duplicate);
    expect(test.task()).toEqual(first);
    expect(first.id).toBe('task-publish-1');

    const rejected = fixture(false);
    await expect(rejected.service.retry('release-1')).rejects.toMatchObject({ status: 409 });
    expect(rejected.state()).toMatchObject({ status: 'failed', retryFromAttempt: null });
    expect(rejected.task()).toBeNull();
    expect(rejected.counts()).toEqual({ postCalls: 0, lookups: 0, remoteChecks: 1 });
  });

  it('allows only one concurrent initial request to claim and POST a retry', async () => {
    const test = fixture();
    const gate = test.blockArtifactVerification();
    const first = test.service.retry('release-1');
    await gate.started;
    const second = test.service.retry('release-1');
    gate.unblock();
    await Promise.all([first, second]);
    expect(test.counts().postCalls).toBe(1);
  }, 15000);

  it('allows only one concurrent resume to claim and POST a retry', async () => {
    const test = fixture();
    await test.service.retry('release-1');
    test.setAttempt(1);
    const gate = test.blockAttemptReads(2);
    const first = test.service.resume('release-1');
    const second = test.service.resume('release-1');
    await gate.entered;
    gate.release();
    await gate.observations;
    gate.releaseObservations();
    await Promise.all([first, second]);
    expect(test.counts().postCalls).toBe(1);
  }, 15000);

  it('does not allow a verifier live result to bypass the Pages pointer transaction', async () => {
    const test = fixture();
    test.setVerification('live');
    await test.service.retry('release-1');
    expect(test.state()).not.toMatchObject({ status: 'live' });
  });

  it('creates a new retry round after the previous retry fails', async () => {
    const test = fixture();
    test.setVerification('failed');
    await test.service.retry('release-1');
    expect(test.state()).toMatchObject({ status: 'failed', workflowRunAttempt: 2, retryFromAttempt: 1 });
    test.setVerification('pending_verification');
    const second = await test.service.retry('release-1');
    expect(test.state()).toMatchObject({ status: 'verifying', workflowRunAttempt: 3, retryFromAttempt: 2 });
    expect(second.id).toBe('task-publish-2');
    expect(test.counts().postCalls).toBe(2);
  });

  it('resumes persisted retry after an unknown POST response without sending another POST', async () => {
    const test = fixture();
    test.setPostFailures(1);
    await test.service.retry('release-1');
    expect(test.state().error?.code).toBe('RETRY_POSTING');
    test.setAttempt(2);
    await test.service.resume('release-1');
    expect(test.counts().postCalls).toBe(1);
    expect(test.state()).toMatchObject({ workflowRunAttempt: 2, retryFromAttempt: 1 });
  });

  it('does not block an authorized retry on later unrelated dirty content', async () => {
    const test = fixture();
    await test.service.retry('release-1');
    expect(test.state().status).toBe('verifying');
  });

  it('records a pending verification result when a network timeout leaves the run outcome unknown', async () => {
    const test = fixture();
    await test.service.retry('release-1');
    const outcome = await test.service.recordVerificationOutcome('release-1', async () => { throw new Error('timeout'); });
    expect(outcome).toBe('pending_verification');
    expect(test.state().status).toBe('verifying');
    expect(test.state().error).toMatchObject({ code: 'PENDING_VERIFICATION', retryable: true });
  });
});
