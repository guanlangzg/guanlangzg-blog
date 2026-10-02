import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { createPagesPublisher, verifyPagesDeployment, type DeploymentRun, type PagesDeploymentAdapter, type PagesPublisherAdapter } from '@/lib/publishing/pages';
import type { LivePointer, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const baseRun: DeploymentRun = {
  id: 44, headSha: 'a'.repeat(40), branch: 'main', workflow: '.github/workflows/deploy.yml', runAttempt: 2,
  status: 'completed', conclusion: 'success',
};
const successfulAttempt = {
  run: baseRun,
  jobs: [{ name: 'deploy', status: 'completed', conclusion: 'success', steps: [
    { name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'success' },
  ] }],
};
function adapter(overrides: Partial<PagesDeploymentAdapter> = {}): PagesDeploymentAdapter {
  return {
    findWorkflowRuns: async () => [baseRun],
    getRunAttemptWithJobs: async () => successfulAttempt,
    readReleaseMarker: async () => ({ releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64) }),
    ...overrides,
  };
}
const expected = {
  releaseId: 'release-1', candidateDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64),
  publicCommitSha: 'a'.repeat(40), branch: 'main', workflow: 'deploy.yml', workflowRunId: 44,
  workflowRunAttempt: 2,
};
const siteSnapshot: SiteSnapshot = {
  schemaVersion: 1, siteId: 'site', articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
  media: [], redirects: [], removedPaths: [],
};
const release: ReleaseRecord = {
  schemaVersion: 1, id: 'release-1', scope: { kind: 'article', articleId: 'a', action: 'publish' },
  baseLiveReleaseId: null, selectedRevision: 'd'.repeat(64), candidateDigest: computeCandidateDigest(siteSnapshot),
  artifactDigest: null, status: 'preview_ready', backupProof: null, publicCommitSha: null,
  workflowRunId: null, workflowRunAttempt: null, retryFromAttempt: null, error: null,
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
};
const expectedRemote = { branch: 'main', headSha: 'e'.repeat(40), workflowPath: '.github/workflows/deploy.yml', workflowDigest: 'workflow-hash', managedConventionDigest: 'site-convention' };
const fileBytes = new TextEncoder().encode('public index');
const fileDigest = createHash('sha256').update(fileBytes).digest('hex');
const artifactDigest = createHash('sha256').update(`app/out/index.html\0${fileBytes.length}\0${fileDigest}`).digest('hex');
const markerBytes = new TextEncoder().encode(JSON.stringify({ releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest }));
const markerDigest = createHash('sha256').update(markerBytes).digest('hex');
const artifactManifest = {
  version: 1 as const, releaseId: release.id, candidateDigest: release.candidateDigest,
  files: [
    { path: 'app/out/_release.json', size: markerBytes.length, sha256: markerDigest },
    { path: 'app/out/index.html', size: fileBytes.length, sha256: fileDigest },
  ],
  artifactDigest,
};
const sealedFiles = [
  { path: 'app/out/_release.json', bytes: markerBytes },
  { path: 'app/out/index.html', bytes: fileBytes },
];

function publisherAdapter(overrides: Partial<PagesPublisherAdapter> = {}): PagesPublisherAdapter {
  return {
    ...adapter(),
    readRemoteState: async () => expectedRemote,
    readSealedSite: async () => ({ manifest: artifactManifest, files: sealedFiles }),
    commitSiteSubtree: async ({ parentCommitSha, force }) => {
      expect(force).toBe(false);
      return { parentCommitSha, commitSha: 'f'.repeat(40) };
    },
    ...overrides,
  };
}

function promotionFixture(overrides: Partial<PagesPublisherAdapter> = {}) {
  const identity = { ...expected, candidateDigest: release.candidateDigest, artifactDigest };
  let current: ReleaseRecord = {
    ...release, status: 'verifying', artifactDigest, publicCommitSha: identity.publicCommitSha,
    workflowRunId: identity.workflowRunId, workflowRunAttempt: identity.workflowRunAttempt,
  };
  let pointer: LivePointer | null = null;
  let backupCount = 0;
  let failAt: 'pointer' | 'backup' | null = null;
  const publisher = createPagesPublisher(publisherAdapter({
    readReleaseMarker: async () => ({ releaseId: identity.releaseId, candidateDigest: identity.candidateDigest, artifactDigest }),
    ...overrides,
  }), {
    withContentLock: async (operation) => operation({
      readRelease: () => ({ release: structuredClone(current), snapshot: structuredClone(siteSnapshot) }),
      listReleases: () => [structuredClone(current)], readLivePointer: () => pointer,
      writeRelease: (next) => { current = structuredClone(next); },
      writeLivePointer: (next) => {
        if (failAt === 'pointer') throw new Error('interrupted pointer write');
        pointer = structuredClone(next);
      },
      enqueuePointerBackup: () => {
        if (failAt === 'backup') throw new Error('interrupted pointer backup enqueue');
        backupCount += 1;
      },
    }),
    now: () => '2026-10-01T00:00:00.000Z',
  });
  return {
    identity, publisher, state: () => ({ release: current, pointer, backupCount }),
    interrupt: (target: typeof failAt) => { failAt = target; },
  };
}

describe('Pages exact deployment proof', () => {
  it('matches the configured workflow selector to the exact API workflow path', async () => {
    const run = { ...baseRun, workflow: '.github/workflows/deploy.yml' };
    const result = await verifyPagesDeployment(expected, adapter({
      findWorkflowRuns: async () => [run],
      getRunAttemptWithJobs: async () => ({ ...successfulAttempt, run }),
    }));
    expect(result.kind).toBe('live');
  });

  it('does not show live when the verified pointer write is interrupted', async () => {
    const test = promotionFixture();
    test.interrupt('pointer');
    await expect(test.publisher.verifyAndPromote(test.identity)).rejects.toThrow(/interrupted/);
    expect(test.state().release.status).toBe('verifying');
    expect(test.state().pointer).toBeNull();
    test.interrupt(null);
    await expect(test.publisher.verifyAndPromote(test.identity)).resolves.toMatchObject({ kind: 'live' });
    expect(test.state().release.status).toBe('live');
    expect(test.state().pointer).toMatchObject({ releaseId: test.identity.releaseId });
  });

  it('reconciles an already written pointer after backup enqueue was interrupted', async () => {
    const test = promotionFixture();
    test.interrupt('backup');
    await expect(test.publisher.verifyAndPromote(test.identity)).rejects.toThrow(/interrupted/);
    expect(test.state().release.status).toBe('verifying');
    expect(test.state().pointer).toMatchObject({ releaseId: test.identity.releaseId });
    test.interrupt(null);
    await expect(test.publisher.verifyAndPromote(test.identity)).resolves.toMatchObject({ kind: 'live' });
    expect(test.state().release.status).toBe('live');
    expect(test.state().backupCount).toBe(1);
    await expect(test.publisher.verifyAndPromote(test.identity)).resolves.toMatchObject({ kind: 'live' });
    expect(test.state().pointer).toMatchObject({ publicCommitSha: test.identity.publicCommitSha, workflowRunAttempt: 2 });
    expect(test.state().backupCount).toBe(1);
  });

  it('keeps the verified live release and pointer after a later run lookup outage', async () => {
    let remoteAvailable = true;
    const test = promotionFixture({
      findWorkflowRuns: async () => {
        if (!remoteAvailable) throw new Error('upstream unavailable');
        return [baseRun];
      },
    });
    expect((await test.publisher.verifyAndPromote(test.identity)).kind).toBe('live');
    remoteAvailable = false;
    expect((await test.publisher.verifyAndPromote(test.identity)).kind).toBe('pending_verification');
    expect(test.state().release.status).toBe('live');
    expect(test.state().pointer).toMatchObject({ releaseId: test.identity.releaseId });
  });

  it.each(['failure', 'cancelled'])('keeps a determined %s deployment retryable without changing live', async (conclusion) => {
    const test = promotionFixture();
    let persisted: ReleaseRecord | null = null;
    const publisher = createPagesPublisher(publisherAdapter({
      findWorkflowRuns: async () => [{ ...baseRun, conclusion }],
      getRunAttemptWithJobs: async () => ({ ...successfulAttempt, run: { ...baseRun, conclusion } }),
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: test.state().release, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { persisted = next; },
        writeLivePointer: () => { throw new Error('failed deployment must not write live'); },
        enqueuePointerBackup: () => { throw new Error('failed deployment must not enqueue live'); },
      }),
    });
    await expect(publisher.verifyAndPromote(test.identity)).resolves.toMatchObject({ kind: 'failed' });
    expect(persisted).toMatchObject({ status: 'failed', error: { code: 'DEPLOYMENT_FAILED', retryable: true } });
  });

  it('rejects a wrong commit, branch, workflow, attempt, or skipped deployment job/step', async () => {
    const cases: Array<[string, DeploymentRun, typeof successfulAttempt]> = [
      ['head sha', { ...baseRun, headSha: 'd'.repeat(40) }, successfulAttempt],
      ['branch', { ...baseRun, branch: 'preview' }, successfulAttempt],
      ['workflow', { ...baseRun, workflow: 'other.yml' }, successfulAttempt],
      ['attempt', { ...baseRun, runAttempt: 1 }, successfulAttempt],
      ['skipped deployment job', baseRun, { run: baseRun, jobs: [{ ...successfulAttempt.jobs[0], conclusion: 'skipped' }] }],
      ['skipped deployment step', baseRun, { run: baseRun, jobs: [{ ...successfulAttempt.jobs[0], steps: [{ name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'skipped' }] }] }],
    ];
    for (const [label, run, attempt] of cases) {
      const result = await verifyPagesDeployment(expected, adapter({ findWorkflowRuns: async () => [run], getRunAttemptWithJobs: async () => attempt }));
      expect(result.kind, label).not.toBe('live');
    }
  });

  it('marks live only for the exact successful attempt and matching uncached release marker', async () => {
    let markerUrl = '';
    const result = await verifyPagesDeployment(expected, adapter({
      readReleaseMarker: async (url, options) => {
        markerUrl = url;
        expect(options.cache).toBe('no-store');
        return { releaseId: expected.releaseId, candidateDigest: expected.candidateDigest, artifactDigest: expected.artifactDigest };
      },
    }));

    expect(result.kind).toBe('live');
    expect(markerUrl).toBe('https://guanlangzg.github.io/_release.json');
  });

  it('keeps network timeouts in pending verification without claiming live or failure', async () => {
    const result = await verifyPagesDeployment(expected, adapter({
      getRunAttemptWithJobs: async () => { throw new Error('timeout'); },
    }));
    expect(result.kind).toBe('pending_verification');
  });

  it('persists verifying state when the exact workflow run has not appeared yet', async () => {
    let persisted: ReleaseRecord | null = null;
    const publisher = createPagesPublisher(publisherAdapter({
      findWorkflowRuns: async () => [],
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: { ...release, artifactDigest: artifactManifest.artifactDigest, publicCommitSha: 'f'.repeat(40) }, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { persisted = next; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });

    const identity = await publisher.captureWorkflowRun('release-1', { branch: 'main', workflow: 'deploy.yml' });

    expect(identity).toBeNull();
    expect(persisted).toMatchObject({ status: 'verifying', error: { code: 'PENDING_VERIFICATION', retryable: true } });
  });

  it('captures the API workflow path when configured with its bare file name', async () => {
    let persisted: ReleaseRecord | null = null;
    const publisher = createPagesPublisher(publisherAdapter(), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: { ...release, artifactDigest: artifactManifest.artifactDigest, publicCommitSha: 'a'.repeat(40) }, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { persisted = next; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });
    const identity = await publisher.captureWorkflowRun('release-1', { branch: 'main', workflow: 'deploy.yml' });
    expect(identity).toMatchObject({ workflowRunId: 44, workflowRunAttempt: 2, workflow: 'deploy.yml' });
    expect(persisted).toMatchObject({ workflowRunId: 44, workflowRunAttempt: 2 });
  });

  it('keeps workflow capture pending when several runs match the same publish commit', async () => {
    let current: ReleaseRecord = { ...release, status: 'deploying', artifactDigest, publicCommitSha: 'a'.repeat(40) };
    const publisher = createPagesPublisher(publisherAdapter({
      findWorkflowRuns: async () => [baseRun, { ...baseRun, id: 45 }],
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: current, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { current = next; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });

    expect(await publisher.captureWorkflowRun(release.id, { branch: 'main', workflow: 'deploy.yml' })).toBeNull();
    expect(current.workflowRunId).toBeNull();
    expect(current.error?.code).toBe('PENDING_VERIFICATION');
  });

  it('keeps an already bound run when another run shares its commit', async () => {
    let current: ReleaseRecord = {
      ...release, status: 'verifying', artifactDigest, publicCommitSha: 'a'.repeat(40),
      workflowRunId: 44, workflowRunAttempt: 2,
    };
    const publisher = createPagesPublisher(publisherAdapter({
      findWorkflowRuns: async () => [baseRun, { ...baseRun, id: 45 }],
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: current, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { current = next; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });

    expect(await publisher.captureWorkflowRun(release.id, { branch: 'main', workflow: 'deploy.yml' }))
      .toMatchObject({ workflowRunId: 44, workflowRunAttempt: 2 });
    expect(current.workflowRunId).toBe(44);
  });

  it('does not return a workflow identity when the release changes during capture', async () => {
    let current: ReleaseRecord = { ...release, status: 'deploying', artifactDigest, publicCommitSha: 'a'.repeat(40) };
    const publisher = createPagesPublisher(publisherAdapter({
      findWorkflowRuns: async () => {
        current = { ...current, publicCommitSha: 'e'.repeat(40) };
        return [baseRun];
      },
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: current, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { current = next; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });

    expect(await publisher.captureWorkflowRun(release.id, { branch: 'main', workflow: 'deploy.yml' })).toBeNull();
    expect(current.workflowRunId).toBeNull();
    expect(current.publicCommitSha).toBe('e'.repeat(40));
  });

  it('reuses a matching remote release marker instead of submitting the site twice', async () => {
    let commitCalls = 0;
    let persistedCommit = '';
    const publisher = createPagesPublisher(publisherAdapter({
      findExistingCommit: async () => 'f'.repeat(40),
      commitSiteSubtree: async () => {
        commitCalls += 1;
        return { commitSha: 'f'.repeat(40), parentCommitSha: expectedRemote.headSha };
      },
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: { ...release, artifactDigest: artifactManifest.artifactDigest }, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { persistedCommit = next.publicCommitSha ?? ''; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
    });

    const result = await publisher.commit({
      release: { ...release, artifactDigest: artifactManifest.artifactDigest }, snapshot: siteSnapshot,
      branch: 'main', workflow: 'deploy.yml', workflowPath: expectedRemote.workflowPath,
      expectedWorkflowDigest: expectedRemote.workflowDigest,
      expectedManagedConventionDigest: expectedRemote.managedConventionDigest,
    });

    expect(commitCalls).toBe(0);
    expect(result.publicCommitSha).toBe('f'.repeat(40));
    expect(persistedCommit).toBe('f'.repeat(40));
  });

  it('commits only the sealed site subtree with the verified parent and no force push', async () => {
    let persistedCommit = '';
    let commitCalls = 0;
    const publisher = createPagesPublisher(publisherAdapter({
      readRemoteState: async () => expectedRemote,
      commitSiteSubtree: async (input) => {
        commitCalls += 1;
        expect(input).toMatchObject({ branch: 'main', parentCommitSha: expectedRemote.headSha, force: false });
        expect(input.files.map((file) => file.path)).toEqual(['site/_release.json', 'site/index.html']);
        return { commitSha: 'f'.repeat(40), parentCommitSha: expectedRemote.headSha };
      },
    }), {
      withContentLock: async (operation) => operation({
        readRelease: () => ({ release: { ...release, artifactDigest: artifactManifest.artifactDigest }, snapshot: siteSnapshot }),
        listReleases: () => [], readLivePointer: () => null,
        writeRelease: (next) => { persistedCommit = next.publicCommitSha ?? ''; },
        writeLivePointer: () => undefined, enqueuePointerBackup: () => undefined,
      }),
      now: () => '2026-09-30T00:00:00.000Z',
    });

    const result = await publisher.commit({
      release: { ...release, artifactDigest: artifactManifest.artifactDigest }, snapshot: siteSnapshot,
      branch: 'main', workflow: 'deploy.yml', workflowPath: expectedRemote.workflowPath,
      expectedWorkflowDigest: expectedRemote.workflowDigest,
      expectedManagedConventionDigest: expectedRemote.managedConventionDigest,
    });

    expect(commitCalls).toBe(1);
    expect(result.publicCommitSha).toBe('f'.repeat(40));
    expect(persistedCommit).toBe(result.publicCommitSha);
  });
});
