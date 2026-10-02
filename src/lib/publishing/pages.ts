import { createHash } from 'node:crypto';
import type { PublicArtifactManifest } from '@/public-site/types';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import type { LivePointer, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const PAGES_RELEASE_MARKER_URL = 'https://guanlangzg.github.io/_release.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export class PagesPublisherError extends Error {
  constructor(message: string, public readonly status: 409 | 502, public readonly code: 'PAGES_CONFLICT' | 'PAGES_ARTIFACT_INVALID') {
    super(message);
    this.name = 'PagesPublisherError';
  }
}

export interface PagesRemoteState {
  branch: string;
  headSha: string;
  workflowPath: string;
  workflowDigest: string;
  managedConventionDigest: string;
}

export interface PagesSiteFile {
  path: string;
  bytes: Uint8Array;
}

export interface PagesDeploymentAdapter {
  findWorkflowRuns(query: { headSha: string; branch: string; workflow: string }): Promise<DeploymentRun[]>;
  getRunAttemptWithJobs(runId: number, attempt: number): Promise<DeploymentAttemptWithJobs>;
  verifyPagesSiteUrl?(configuredUrl: string): Promise<boolean>;
  readReleaseMarker(url: string, options: { cache: 'no-store' }): Promise<unknown>;
}

export interface DeploymentRun {
  id: number;
  headSha: string;
  branch: string;
  workflow: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
}

export interface DeploymentAttemptWithJobs {
  run: DeploymentRun;
  jobs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    steps: Array<{ name: string; status: string; conclusion: string | null }>;
  }>;
}

export interface PagesVerificationIdentity {
  releaseId: string;
  candidateDigest: string;
  artifactDigest: string;
  publicCommitSha: string;
  branch: string;
  workflow: string;
  workflowRunId: number;
  workflowRunAttempt: number;
}

export type PagesVerificationResult =
  | { kind: 'live'; verifiedAt: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'pending_verification'; message: string };

export interface PagesPublisherAdapter extends PagesDeploymentAdapter {
  readRemoteState(branch: string): Promise<PagesRemoteState>;
  readSealedSite(input: { releaseId: string; candidateDigest: string; artifactDigest: string }): Promise<{ manifest: PublicArtifactManifest; files: PagesSiteFile[] }>;
  commitSiteSubtree(input: {
    branch: string;
    parentCommitSha: string;
    workflowPath: string;
    workflowDigest: string;
    managedConventionDigest: string;
    files: PagesSiteFile[];
    releaseId: string;
    force: false;
  }): Promise<{ commitSha: string; parentCommitSha: string }>;
  findExistingCommit?(input: {
    branch: string;
    releaseId: string;
    candidateDigest: string;
    artifactDigest: string;
  }): Promise<string | null>;
}

export interface PagesPublishInput {
  release: ReleaseRecord;
  snapshot: SiteSnapshot;
  branch: string;
  workflow: string;
  workflowPath: string;
  expectedWorkflowDigest: string;
  expectedManagedConventionDigest: string;
}

export interface PagesPublisherHooks {
  withContentLock<T>(operation: (transaction: PagesPublishTransaction) => T | Promise<T>): Promise<T>;
  now?: () => string;
  deploymentJobName?: string;
  deploymentStepName?: string;
  releaseMarkerUrl?: string;
}

export interface PagesPublishTransaction {
  readRelease(releaseId: string): { release: ReleaseRecord; snapshot: SiteSnapshot };
  listReleases(): ReleaseRecord[];
  readLivePointer(): LivePointer | null;
  writeRelease(release: ReleaseRecord, snapshot: SiteSnapshot): void;
  writeLivePointer(pointer: LivePointer): void;
  enqueuePointerBackup(pointer: LivePointer): void;
}

function isValidMarker(value: unknown): value is { releaseId: string; candidateDigest: string; artifactDigest: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return typeof marker.releaseId === 'string' && SHA256_PATTERN.test(String(marker.candidateDigest))
    && SHA256_PATTERN.test(String(marker.artifactDigest));
}

function workflowMatches(actual: string, expected: string): boolean {
  const actualPath = actual.replaceAll('\\', '/').replace(/^\.\//, '');
  const expectedPath = expected.replaceAll('\\', '/').replace(/^\.\//, '');
  return actualPath === (expectedPath.includes('/') ? expectedPath : `.github/workflows/${expectedPath}`);
}

function deploymentJobSucceeded(attempt: DeploymentAttemptWithJobs, jobName: string, stepName: string): boolean {
  const deploymentJob = attempt.jobs.find((job) => job.name === jobName);
  if (!deploymentJob || deploymentJob.status !== 'completed' || deploymentJob.conclusion !== 'success') return false;
  const deploymentStep = deploymentJob.steps.find((step) => step.name === stepName);
  return deploymentStep?.status === 'completed' && deploymentStep.conclusion === 'success';
}

export async function verifyPagesDeployment(
  expected: PagesVerificationIdentity,
  adapter: PagesDeploymentAdapter,
  options: { deploymentJobName?: string; deploymentStepName?: string; releaseMarkerUrl?: string; now?: () => string } = {}
): Promise<PagesVerificationResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const releaseMarkerUrl = options.releaseMarkerUrl ?? PAGES_RELEASE_MARKER_URL;
  try {
    if (adapter.verifyPagesSiteUrl && !await adapter.verifyPagesSiteUrl(releaseMarkerUrl)) {
      return { kind: 'failed', code: 'PAGES_SITE_MISMATCH', message: 'The configured release marker URL does not belong to the connected GitHub Pages site.' };
    }
  } catch {
    return { kind: 'pending_verification', message: 'The GitHub Pages site identity could not be verified.' };
  }

  let attempt: DeploymentAttemptWithJobs;
  try {
    const runs = await adapter.findWorkflowRuns({
      headSha: expected.publicCommitSha,
      branch: expected.branch,
      workflow: expected.workflow,
    });
    const exactRun = runs.find((run) => run.id === expected.workflowRunId && run.headSha === expected.publicCommitSha
      && run.branch === expected.branch && workflowMatches(run.workflow, expected.workflow) && run.runAttempt === expected.workflowRunAttempt);
    if (!exactRun) return { kind: 'pending_verification', message: 'The exact workflow run attempt is not available yet.' };
    attempt = await adapter.getRunAttemptWithJobs(expected.workflowRunId, expected.workflowRunAttempt);
  } catch {
    return { kind: 'pending_verification', message: 'Deployment verification is pending after an upstream query failure.' };
  }

  const run = attempt.run;
  if (run.id !== expected.workflowRunId || run.headSha !== expected.publicCommitSha || run.branch !== expected.branch
      || !workflowMatches(run.workflow, expected.workflow) || run.runAttempt !== expected.workflowRunAttempt) {
    return { kind: 'pending_verification', message: 'The returned attempt identity does not match the requested deployment.' };
  }
  if (run.status !== 'completed') return { kind: 'pending_verification', message: 'The deployment attempt has not completed.' };
  if (run.conclusion !== 'success') {
    if (run.conclusion !== 'failure' && run.conclusion !== 'cancelled') {
      return { kind: 'pending_verification', message: 'The deployment attempt outcome is not conclusive.' };
    }
    return { kind: 'failed', code: 'DEPLOYMENT_FAILED', message: 'The specified deployment attempt did not succeed.' };
  }
  if (!deploymentJobSucceeded(attempt, options.deploymentJobName ?? 'deploy', options.deploymentStepName ?? 'Deploy to GitHub Pages')) {
    return { kind: 'failed', code: 'DEPLOYMENT_STEP_FAILED', message: 'The Pages deployment job and step must both complete successfully.' };
  }

  let marker: unknown;
  try {
    marker = await adapter.readReleaseMarker(releaseMarkerUrl, { cache: 'no-store' });
  } catch {
    return { kind: 'pending_verification', message: 'The public release marker could not be read; verification remains pending.' };
  }
  if (!isValidMarker(marker) || marker.releaseId !== expected.releaseId || marker.candidateDigest !== expected.candidateDigest
      || marker.artifactDigest !== expected.artifactDigest) {
    return { kind: 'failed', code: 'RELEASE_MARKER_MISMATCH', message: 'The public release marker does not match this release.' };
  }
  return { kind: 'live', verifiedAt: now() };
}

function verifySealedFiles(
  input: PagesPublishInput,
  sealed: { manifest: PublicArtifactManifest; files: PagesSiteFile[] }
): PagesSiteFile[] {
  const { manifest, files } = sealed;
  if (manifest.version !== 1 || manifest.releaseId !== input.release.id || manifest.candidateDigest !== input.release.candidateDigest
      || manifest.artifactDigest !== input.release.artifactDigest || input.release.artifactDigest === null
      || computeCandidateDigest(input.snapshot) !== input.release.candidateDigest) {
    throw new PagesPublisherError('The sealed Pages artifact identity does not match the release.', 409, 'PAGES_ARTIFACT_INVALID');
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  if (byPath.size !== files.length || files.length !== manifest.files.length) {
    throw new PagesPublisherError('The sealed Pages artifact file list is inconsistent.', 409, 'PAGES_ARTIFACT_INVALID');
  }
  let markerFound = false;
  const siteFiles: PagesSiteFile[] = [];
  const manifestPaths = new Set<string>();
  const digestEntries: string[] = [];
  for (const entry of manifest.files) {
    if (manifestPaths.has(entry.path)) {
      throw new PagesPublisherError('The sealed Pages artifact contains duplicate paths.', 409, 'PAGES_ARTIFACT_INVALID');
    }
    manifestPaths.add(entry.path);
    if (!entry.path.startsWith('app/out/') || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !SHA256_PATTERN.test(entry.sha256)) {
      throw new PagesPublisherError('The sealed Pages artifact contains an unsupported file entry.', 409, 'PAGES_ARTIFACT_INVALID');
    }
    const file = byPath.get(entry.path);
    if (!file || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new PagesPublisherError('The sealed Pages artifact contains an invalid path.', 409, 'PAGES_ARTIFACT_INVALID');
    }
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    if (file.bytes.byteLength !== entry.size || sha256 !== entry.sha256) {
      throw new PagesPublisherError('The sealed Pages artifact bytes do not match its manifest.', 409, 'PAGES_ARTIFACT_INVALID');
    }
    if (entry.path !== 'app/out/_release.json') digestEntries.push(`${entry.path}\0${entry.size}\0${entry.sha256}`);
    if (entry.path === 'app/out/_release.json') {
      let marker: unknown;
      try {
        marker = JSON.parse(new TextDecoder().decode(file.bytes)) as unknown;
      } catch {
        throw new PagesPublisherError('The sealed release marker is invalid.', 409, 'PAGES_ARTIFACT_INVALID');
      }
      if (!isValidMarker(marker) || marker.releaseId !== input.release.id || marker.candidateDigest !== input.release.candidateDigest
          || marker.artifactDigest !== input.release.artifactDigest) {
        throw new PagesPublisherError('The sealed release marker does not match the release.', 409, 'PAGES_ARTIFACT_INVALID');
      }
      markerFound = true;
    }
    if (entry.path.startsWith('app/out/')) {
      siteFiles.push({ path: `site/${entry.path.slice('app/out/'.length)}`, bytes: file.bytes });
    }
  }
  const computedDigest = createHash('sha256').update(digestEntries.join('\n')).digest('hex');
  if (!markerFound || siteFiles.length === 0 || computedDigest !== manifest.artifactDigest) {
    throw new PagesPublisherError('The sealed artifact does not contain a valid marker or its artifact digest is inconsistent.', 409, 'PAGES_ARTIFACT_INVALID');
  }
  return siteFiles;
}

function assertRemoteConvention(
  state: PagesRemoteState,
  input: PagesPublishInput
): void {
  if (state.branch !== input.branch || state.workflowPath !== input.workflowPath
      || state.workflowDigest !== input.expectedWorkflowDigest
      || state.managedConventionDigest !== input.expectedManagedConventionDigest) {
    throw new PagesPublisherError('The Pages workflow or managed site convention changed remotely.', 409, 'PAGES_CONFLICT');
  }
}

function ensureLiveTransaction(
  tx: PagesPublishTransaction,
  expected: PagesVerificationIdentity,
  verifiedAt: string
): LivePointer {
  const { release, snapshot } = tx.readRelease(expected.releaseId);
  if (release.publicCommitSha !== expected.publicCommitSha || release.candidateDigest !== expected.candidateDigest
      || release.artifactDigest !== expected.artifactDigest || release.workflowRunId !== expected.workflowRunId
      || release.workflowRunAttempt !== expected.workflowRunAttempt) {
    throw new PagesPublisherError('Persisted release identity changed before live promotion.', 409, 'PAGES_CONFLICT');
  }
  const currentPointer = tx.readLivePointer();
  if (currentPointer && currentPointer.releaseId === release.id) {
    if (currentPointer.candidateDigest !== expected.candidateDigest
        || currentPointer.artifactDigest !== expected.artifactDigest
        || currentPointer.publicCommitSha !== expected.publicCommitSha
        || currentPointer.workflowRunId !== expected.workflowRunId
        || currentPointer.workflowRunAttempt !== expected.workflowRunAttempt) {
      throw new PagesPublisherError('Persisted live pointer identity changed before promotion.', 409, 'PAGES_CONFLICT');
    }
  } else if ((currentPointer?.releaseId ?? null) !== release.baseLiveReleaseId) {
    throw new PagesPublisherError('The live baseline changed before live promotion.', 409, 'PAGES_CONFLICT');
  }

  const pointer: LivePointer = {
    schemaVersion: 1,
    releaseId: release.id,
    candidateDigest: release.candidateDigest,
    artifactDigest: expected.artifactDigest,
    publicCommitSha: expected.publicCommitSha,
    workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
    verifiedAt: currentPointer?.releaseId === release.id ? currentPointer.verifiedAt : verifiedAt,
  };
  if (!currentPointer || currentPointer.releaseId !== release.id) tx.writeLivePointer(pointer);
  if (release.status !== 'live' || !currentPointer || currentPointer.releaseId !== release.id) {
    tx.enqueuePointerBackup(pointer);
  }
  if (release.status !== 'live') {
    tx.writeRelease({ ...release, status: 'live', error: null, updatedAt: pointer.verifiedAt }, snapshot);
  }
  for (const old of tx.listReleases()) {
    if (old.id !== release.id && old.status === 'preview_ready' && old.baseLiveReleaseId !== release.id) {
      const prior = tx.readRelease(old.id);
      tx.writeRelease({ ...prior.release, status: 'stale', error: { code: 'STALE_BASELINE', message: 'A newer release became live.', retryable: false }, updatedAt: verifiedAt }, prior.snapshot);
    }
  }
  return pointer;
}

export function createPagesPublisher(adapter: PagesPublisherAdapter, hooks: PagesPublisherHooks) {
  const now = hooks.now ?? (() => new Date().toISOString());

  return {
    async commit(input: PagesPublishInput): Promise<{ publicCommitSha: string }> {
      const initial = await adapter.readRemoteState(input.branch);
      assertRemoteConvention(initial, input);
      const sealed = await adapter.readSealedSite({
        releaseId: input.release.id,
        candidateDigest: input.release.candidateDigest,
        artifactDigest: input.release.artifactDigest ?? '',
      });
      const siteFiles = verifySealedFiles(input, sealed);
      const current = await adapter.readRemoteState(input.branch);
      assertRemoteConvention(current, input);
      if (current.headSha !== initial.headSha) throw new PagesPublisherError('Pages branch advanced; retry against the new parent.', 409, 'PAGES_CONFLICT');

      let publicCommitSha: string | null = null;
      if (adapter.findExistingCommit && input.release.artifactDigest) {
        const existing = await adapter.findExistingCommit({
          branch: input.branch,
          releaseId: input.release.id,
          candidateDigest: input.release.candidateDigest,
          artifactDigest: input.release.artifactDigest,
        });
        if (existing !== null) {
          if (!COMMIT_PATTERN.test(existing)) {
            throw new PagesPublisherError('The existing Pages commit identity is invalid.', 409, 'PAGES_CONFLICT');
          }
          publicCommitSha = existing;
        }
      }

      if (!publicCommitSha) {
        const committed = await adapter.commitSiteSubtree({
          branch: input.branch,
          parentCommitSha: initial.headSha,
          workflowPath: input.workflowPath,
          workflowDigest: input.expectedWorkflowDigest,
          managedConventionDigest: input.expectedManagedConventionDigest,
          files: siteFiles,
          releaseId: input.release.id,
          force: false,
        });
        if (committed.parentCommitSha !== initial.headSha || !COMMIT_PATTERN.test(committed.commitSha)) {
          throw new PagesPublisherError('Pages commit did not preserve the expected parent commit.', 409, 'PAGES_CONFLICT');
        }
        publicCommitSha = committed.commitSha;
      }

      await hooks.withContentLock((tx) => {
        const stored = tx.readRelease(input.release.id);
        if (stored.release.candidateDigest !== input.release.candidateDigest || stored.release.artifactDigest !== input.release.artifactDigest) {
          throw new PagesPublisherError('Release changed before Pages commit persistence.', 409, 'PAGES_CONFLICT');
        }
        tx.writeRelease({ ...stored.release, status: 'deploying', publicCommitSha, error: null, updatedAt: now() }, stored.snapshot);
      });
      return { publicCommitSha };

    },

    async captureWorkflowRun(
      releaseId: string,
      input: { branch: string; workflow: string }
    ): Promise<PagesVerificationIdentity | null> {
      const { release } = await hooks.withContentLock((tx) => tx.readRelease(releaseId));
      if (!release.publicCommitSha || !release.artifactDigest) throw new PagesPublisherError('Pages commit is not persisted.', 409, 'PAGES_CONFLICT');
      let runs: DeploymentRun[];
      try {
        runs = await adapter.findWorkflowRuns({ headSha: release.publicCommitSha, branch: input.branch, workflow: input.workflow });
      } catch {
        await hooks.withContentLock((tx) => {
          const stored = tx.readRelease(releaseId);
          tx.writeRelease({ ...stored.release, status: 'verifying', error: { code: 'PENDING_VERIFICATION', message: 'Deployment run lookup is pending.', retryable: true }, updatedAt: now() }, stored.snapshot);
        });
        return null;
      }
      const matches = runs.filter((item) => item.headSha === release.publicCommitSha && item.branch === input.branch
        && workflowMatches(item.workflow, input.workflow) && Number.isSafeInteger(item.runAttempt) && item.runAttempt > 0);
      const run = release.workflowRunId === null
        ? (matches.length === 1 ? matches[0] : undefined)
        : matches.find((item) => item.id === release.workflowRunId && item.runAttempt === release.workflowRunAttempt);
      if (!run) {
        await hooks.withContentLock((tx) => {
          const stored = tx.readRelease(releaseId);
          if (stored.release.publicCommitSha !== release.publicCommitSha || stored.release.status === 'live') return;
          tx.writeRelease({
            ...stored.release,
            status: 'verifying',
            error: {
              code: 'PENDING_VERIFICATION',
              message: matches.length > 1 && release.workflowRunId === null
                ? 'Several workflow runs match the commit; the exact deployment run cannot be identified.'
                : 'Deployment run is pending publication.',
              retryable: true,
            },
            updatedAt: now(),
          }, stored.snapshot);
        });
        return null;
      }
      const identity: PagesVerificationIdentity = {
        releaseId: release.id,
        candidateDigest: release.candidateDigest,
        artifactDigest: release.artifactDigest,
        publicCommitSha: release.publicCommitSha,
        branch: input.branch,
        workflow: input.workflow,
        workflowRunId: run.id,
        workflowRunAttempt: run.runAttempt,
      };
      const persisted = await hooks.withContentLock((tx) => {
        const stored = tx.readRelease(releaseId);
        if (stored.release.publicCommitSha !== release.publicCommitSha
            || stored.release.candidateDigest !== release.candidateDigest
            || stored.release.artifactDigest !== release.artifactDigest
            || stored.release.status === 'live'
            || (stored.release.workflowRunId !== null && stored.release.workflowRunId !== run.id)
            || (stored.release.workflowRunAttempt !== null && stored.release.workflowRunAttempt !== run.runAttempt)) {
          return false;
        }
        tx.writeRelease({ ...stored.release, status: 'verifying', workflowRunId: run.id, workflowRunAttempt: run.runAttempt, error: null, updatedAt: now() }, stored.snapshot);
        return true;
      });
      return persisted ? identity : null;
    },

    async verifyAndPromote(expected: PagesVerificationIdentity): Promise<PagesVerificationResult> {
      const result = await verifyPagesDeployment(expected, adapter, {
        deploymentJobName: hooks.deploymentJobName,
        deploymentStepName: hooks.deploymentStepName,
        releaseMarkerUrl: hooks.releaseMarkerUrl,
        now,
      });
      if (result.kind === 'live') {
        await hooks.withContentLock((tx) => ensureLiveTransaction(tx, expected, result.verifiedAt));
      } else {
        await hooks.withContentLock((tx) => {
          const stored = tx.readRelease(expected.releaseId);
          if (stored.release.workflowRunId !== expected.workflowRunId || stored.release.workflowRunAttempt !== expected.workflowRunAttempt
              || stored.release.publicCommitSha !== expected.publicCommitSha || stored.release.candidateDigest !== expected.candidateDigest
              || stored.release.artifactDigest !== expected.artifactDigest || stored.release.status === 'live') return;
          const isPending = result.kind === 'pending_verification';
          tx.writeRelease({
            ...stored.release,
            status: isPending ? 'verifying' : 'failed',
            error: { code: isPending ? 'PENDING_VERIFICATION' : result.code, message: result.message, retryable: isPending || result.code === 'DEPLOYMENT_FAILED' },
            updatedAt: now(),
          }, stored.snapshot);
        });
      }
      return result;
    },
  };
}
