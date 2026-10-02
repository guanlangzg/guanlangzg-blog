import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { JobHandler, JobHandlerResult } from '@/lib/jobs/worker';
import { createOrReuseActiveJobUnderLock, type JobRecord } from '@/lib/jobs/store';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { readLivePointer, readRelease, writeLivePointer, writeRelease } from '@/lib/publishing/store';
import {
  createPagesPublisher,
  PagesPublisherError,
  type DeploymentAttemptWithJobs,
  type DeploymentRun,
  type PagesDeploymentAdapter,
  type PagesPublisherAdapter,
  type PagesRemoteState,
  type PagesSiteFile,
  type PagesVerificationIdentity,
  type PagesVerificationResult,
} from '@/lib/publishing/pages';
import type { LivePointer, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { verifyArtifactTree } from '@/lib/public-build/runner';
import type { PublicArtifactManifest } from '@/public-site/types';
import {
  createPublishingGitHubRuntime,
  type PublishingGitHubRuntime,
} from '@/lib/editor-runtime/github-runtime';
import { createEditorReleaseRetryService } from '@/lib/editor-runtime/retry-runtime';
import {
  findSealedArtifactRoot,
} from '@/lib/editor-runtime/adapters';

const RELEASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW = 'deploy.yml';
const DEFAULT_WORKFLOW_PATH = '.github/workflows/deploy.yml';
const DEFAULT_PAGES_URL = 'https://guanlangzg.github.io';
const MANAGED_CONVENTION_PATH = '.github/pages-managed.txt';
const MANAGED_CONVENTION = 'site-subtree-v1|release-marker-v1|force-false\n';
const DEFAULT_MANAGED_CONVENTION_DIGEST = createHash('sha256').update(MANAGED_CONVENTION).digest('hex');

export interface PagesJobRuntime {
  branch: string;
  workflow: string;
  workflowPath: string;
  expectedWorkflowDigest: string;
  expectedManagedConventionDigest: string;
  deploymentJobName?: string;
  deploymentStepName?: string;
  readRelease(releaseId: string): Promise<{ release: ReleaseRecord; snapshot: SiteSnapshot }>;
  commit(input: { release: ReleaseRecord; snapshot: SiteSnapshot }): Promise<void>;
  captureWorkflowRun(releaseId: string): Promise<PagesVerificationIdentity | null>;
  verifyAndPromote(identity: PagesVerificationIdentity): Promise<PagesVerificationResult>;
  enqueueReconcile(releaseId: string, candidateDigest: string, artifactDigest: string): Promise<void>;
  resumeRetry?(releaseId: string): Promise<void>;
}

export interface PagesJobHandlers {
  publish: JobHandler;
  reconcile: JobHandler;
}

interface PagesJobInput {
  releaseId: string;
  candidateDigest: string;
  artifactDigest: string;
  retry: boolean;
  retryFromAttempt: number | null;
}

interface PagesRuntimeConfig {
  branch: string;
  workflow: string;
  workflowPath: string;
  expectedWorkflowDigest: string;
  expectedManagedConventionDigest: string;
  pagesUrl: string;
  deploymentJobName: string;
  deploymentStepName: string;
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function normalizeSiteUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Pages site URL is invalid.');
  }
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return `${url.origin}${pathname}`;
}

function readPagesRuntimeConfig(): PagesRuntimeConfig | null {
  const expectedWorkflowDigest = process.env.BLOG_PAGES_WORKFLOW_DIGEST?.trim() ?? '';
  if (!DIGEST_PATTERN.test(expectedWorkflowDigest)) return null;
  return {
    branch: envOrDefault('BLOG_PAGES_BRANCH', DEFAULT_BRANCH),
    workflow: envOrDefault('BLOG_PAGES_WORKFLOW', DEFAULT_WORKFLOW),
    workflowPath: envOrDefault('BLOG_PAGES_WORKFLOW_PATH', DEFAULT_WORKFLOW_PATH),
    expectedWorkflowDigest,
    expectedManagedConventionDigest: envOrDefault(
      'BLOG_PAGES_MANAGED_CONVENTION_DIGEST',
      DEFAULT_MANAGED_CONVENTION_DIGEST,
    ),
    pagesUrl: envOrDefault('BLOG_PAGES_URL', DEFAULT_PAGES_URL),
    deploymentJobName: envOrDefault('BLOG_PAGES_DEPLOYMENT_JOB', 'deploy'),
    deploymentStepName: envOrDefault('BLOG_PAGES_DEPLOYMENT_STEP', 'Deploy to GitHub Pages'),
  };
}

function parseJobInput(job: JobRecord): PagesJobInput | null {
  if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) {
    throw new Error('Pages job input is invalid.');
  }
  const input = job.input as Record<string, unknown>;
  if (typeof input.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(input.releaseId)
      || typeof input.candidateDigest !== 'string' || !DIGEST_PATTERN.test(input.candidateDigest)
      || (input.retry !== undefined && input.retry !== true)
      || (input.retry === true && (!Number.isSafeInteger(input.retryFromAttempt) || (input.retryFromAttempt as number) < 1))) {
    throw new Error('Pages job input is invalid.');
  }
  if (input.artifactDigest === undefined) return null;
  if (typeof input.artifactDigest !== 'string' || !DIGEST_PATTERN.test(input.artifactDigest)) {
    throw new Error('Pages job input is invalid.');
  }
  return {
    releaseId: input.releaseId,
    candidateDigest: input.candidateDigest,
    artifactDigest: input.artifactDigest,
    retry: input.retry === true,
    retryFromAttempt: input.retry === true ? input.retryFromAttempt as number : null,
  };
}

function assertCandidate(
  input: PagesJobInput,
  stored: { release: ReleaseRecord; snapshot: SiteSnapshot },
): void {
  if (stored.release.id !== input.releaseId || stored.release.candidateDigest !== input.candidateDigest) {
    throw new Error('Pages candidate digest does not match the persisted release.');
  }
  if (computeCandidateDigest(stored.snapshot) !== input.candidateDigest) {
    throw new Error('Pages candidate digest does not match the frozen snapshot.');
  }
  if (stored.release.artifactDigest !== input.artifactDigest) {
    throw new Error('Pages artifact digest does not match the persisted release.');
  }
  if (!stored.release.artifactDigest || !DIGEST_PATTERN.test(stored.release.artifactDigest)) {
    throw new Error('Pages release has no valid sealed artifact digest.');
  }
}

function defer(message: string): JobHandlerResult {
  return { defer: { message } };
}

async function publishJob(runtime: PagesJobRuntime, job: JobRecord): Promise<JobHandlerResult | void> {
  const input = parseJobInput(job);
  if (!input) return { blocked: { message: 'Pages job identity lacks a sealed artifact digest.' } };
  const stored = await runtime.readRelease(input.releaseId);
  assertCandidate(input, stored);
  if (input.retry) {
    if (stored.release.retryFromAttempt !== input.retryFromAttempt) {
      throw new Error('Pages retry task no longer matches the authorized workflow attempt.');
    }
    if (stored.release.status === 'live') return;
    if (stored.release.status === 'failed') return { blocked: { message: 'Pages retry attempt failed; request a new retry round.' } };
    if (!runtime.resumeRetry) return { blocked: { message: 'Pages retry resume handler is unavailable.' } };
    await runtime.resumeRetry(input.releaseId);
    const resumed = await runtime.readRelease(input.releaseId);
    assertCandidate(input, resumed);
    if (resumed.release.retryFromAttempt !== input.retryFromAttempt) {
      throw new Error('Pages retry round changed during reconciliation.');
    }
    if (resumed.release.status === 'live') return;
    if (resumed.release.status === 'failed') return { blocked: { message: 'Pages retry attempt failed; request a new retry round.' } };
    if (resumed.release.workflowRunAttempt !== null && input.retryFromAttempt !== null
        && resumed.release.workflowRunAttempt > input.retryFromAttempt) {
      await runtime.enqueueReconcile(input.releaseId, input.candidateDigest, input.artifactDigest);
    }
    return defer('Pages retry is awaiting its workflow attempt reconciliation.');
  }
  if (stored.release.status === 'live') return;
  if (stored.release.status === 'failed') return { blocked: { message: 'Pages deployment failed; the release can be retried.' } };

  if (stored.release.publicCommitSha === null) {
    if (stored.release.status !== 'publishing') {
      return defer('Pages release is waiting for a publishable state.');
    }
    await runtime.commit(stored);
  }

  try {
    await runtime.captureWorkflowRun(input.releaseId);
  } catch {
    await runtime.enqueueReconcile(input.releaseId, input.candidateDigest, input.artifactDigest);
    return defer('Pages workflow run lookup is pending.');
  }
  await runtime.enqueueReconcile(input.releaseId, input.candidateDigest, input.artifactDigest);
}

function identityFromRelease(runtime: PagesJobRuntime, release: ReleaseRecord): PagesVerificationIdentity | null {
  if (!release.publicCommitSha || !release.artifactDigest || release.workflowRunId === null || release.workflowRunAttempt === null) {
    return null;
  }
  return {
    releaseId: release.id,
    candidateDigest: release.candidateDigest,
    artifactDigest: release.artifactDigest,
    publicCommitSha: release.publicCommitSha,
    branch: runtime.branch,
    workflow: runtime.workflow,
    workflowRunId: release.workflowRunId,
    workflowRunAttempt: release.workflowRunAttempt,
  };
}

async function reconcileJob(runtime: PagesJobRuntime, job: JobRecord): Promise<JobHandlerResult | void> {
  const input = parseJobInput(job);
  if (!input) return { blocked: { message: 'Pages job identity lacks a sealed artifact digest.' } };
  let stored = await runtime.readRelease(input.releaseId);
  assertCandidate(input, stored);
  if (stored.release.retryFromAttempt !== null && stored.release.workflowRunAttempt === stored.release.retryFromAttempt
      && ['RETRY_PENDING', 'RETRY_POSTING', 'PENDING_VERIFICATION'].includes(stored.release.error?.code ?? '')) {
    return defer('Pages retry attempt has not been observed yet.');
  }
  if (stored.release.status === 'failed') return { blocked: { message: 'Pages deployment failed; the release can be retried.' } };
  if (!stored.release.publicCommitSha) return defer('Pages commit is not persisted yet.');

  let identity = identityFromRelease(runtime, stored.release);
  if (!identity) {
    identity = await runtime.captureWorkflowRun(input.releaseId);
    if (!identity) return defer('The exact Pages workflow run is pending and not visible yet.');
    stored = await runtime.readRelease(input.releaseId);
    assertCandidate(input, stored);
  }

  const result = await runtime.verifyAndPromote(identity);
  if (result.kind === 'pending_verification') return defer(result.message);
  if (result.kind === 'failed') return { blocked: { message: result.message } };
}

export async function createPagesJobHandlers(options: { runtime?: PagesJobRuntime } = {}): Promise<PagesJobHandlers | null> {
  const runtime = options.runtime ?? await createProductionPagesJobRuntime();
  if (!runtime) return null;
  return {
    publish: (job) => publishJob(runtime, job),
    reconcile: (job) => reconcileJob(runtime, job),
  };
}

function getString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is unavailable.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function decodeBlob(value: unknown): Uint8Array {
  const blob = record(value, 'GitHub blob');
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('GitHub blob encoding is unsupported.');
  return Buffer.from(blob.content.replace(/\s+/g, ''), 'base64');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeEntries(value: unknown): Array<{ path: string; type: string; sha: string }> {
  const response = record(value, 'GitHub tree');
  if (response.truncated === true) throw new Error('GitHub tree response is truncated; Pages state is incomplete.');
  const tree = response.tree;
  if (!Array.isArray(tree)) throw new Error('GitHub tree response is invalid.');
  return tree.flatMap((entry) => {
    const item = record(entry, 'GitHub tree entry');
    return typeof item.path === 'string' && typeof item.type === 'string' && typeof item.sha === 'string'
      ? [{ path: item.path, type: item.type, sha: item.sha }]
      : [];
  });
}

function commitTreeSha(value: unknown): string {
  return getString(record(record(value, 'GitHub commit').tree, 'GitHub commit tree').sha, 'GitHub commit tree SHA');
}

function parseReleaseMarker(bytes: Uint8Array): { releaseId: string; candidateDigest: string; artifactDigest: string } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof value.releaseId !== 'string' || !DIGEST_PATTERN.test(String(value.candidateDigest))
        || !DIGEST_PATTERN.test(String(value.artifactDigest))) return null;
    return {
      releaseId: value.releaseId,
      candidateDigest: String(value.candidateDigest),
      artifactDigest: String(value.artifactDigest),
    };
  } catch {
    return null;
  }
}

async function readRemoteTree(client: Awaited<ReturnType<PublishingGitHubRuntime['prepareClient']>>, branch: string) {
  const reference = record(await client.getReference('pages', branch), 'Pages branch reference');
  const headSha = getString(record(reference.object, 'Pages branch reference object').sha, 'Pages branch head SHA');
  if (!COMMIT_PATTERN.test(headSha)) throw new Error('Pages branch head SHA is invalid.');
  const commit = await client.getCommit('pages', headSha);
  const rootTreeSha = commitTreeSha(commit);
  return { headSha, entries: treeEntries(await client.getTree('pages', rootTreeSha, true)) };
}

function sealedArtifactRoot(releaseId: string): string {
  const root = findSealedArtifactRoot(releaseId);
  if (!root) throw new Error('Sealed Pages artifact is unavailable.');
  return root;
}

async function readSealedSite(releaseId: string, candidateDigest: string, artifactDigest: string): Promise<{
  manifest: PublicArtifactManifest;
  files: PagesSiteFile[];
}> {
  const root = sealedArtifactRoot(releaseId);
  const manifest = await verifyArtifactTree(root);
  if (manifest.releaseId !== releaseId || manifest.candidateDigest !== candidateDigest || manifest.artifactDigest !== artifactDigest) {
    throw new Error('Sealed Pages artifact identity does not match the release.');
  }
  const files = await Promise.all(manifest.files.map(async (entry) => ({
    path: entry.path,
    bytes: await fsPromises.readFile(path.join(root, entry.path)),
  })));
  return { manifest, files };
}

function listReleaseRecords(): ReleaseRecord[] {
  const releasesRoot = path.join(getRuntimeDataRootPath(), 'workflow', 'releases');
  if (!fs.existsSync(releasesRoot)) return [];
  return fs.readdirSync(releasesRoot)
    .filter((name) => RELEASE_ID_PATTERN.test(name))
    .flatMap((name) => {
      try { return [readRelease(name).release]; } catch { return []; }
    });
}

function pagesTransaction() {
  return {
    readRelease,
    listReleases: listReleaseRecords,
    readLivePointer,
    writeRelease,
    writeLivePointer,
    enqueuePointerBackup(pointer: LivePointer) {
      createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), {
        type: 'backup',
        input: {
          reason: 'live-pointer',
          snapshotId: `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`,
          pointer,
        },
      });
    },
  };
}

function createPagesAdapter(
  github: PublishingGitHubRuntime,
  config: PagesRuntimeConfig,
): PagesPublisherAdapter {
  const deployment: PagesDeploymentAdapter = {
    findWorkflowRuns: async ({ headSha, workflow }): Promise<DeploymentRun[]> =>
      github.listRunsByHeadSha(headSha, workflow),
    getRunAttemptWithJobs: async (runId, attempt): Promise<DeploymentAttemptWithJobs> => {
      const result = await github.getAttemptWithJobs(runId, attempt);
      return {
        run: {
          id: result.runId,
          runAttempt: result.runAttempt,
          headSha: result.headSha,
          status: result.status,
          conclusion: result.conclusion,
          branch: result.branch,
          workflow: result.workflow,
        },
        jobs: result.jobs,
      };
    },
    verifyPagesSiteUrl: async (configuredMarkerUrl) => {
      const githubPagesUrl = await github.getPagesSiteUrl();
      const configuredSiteUrl = new URL('.', configuredMarkerUrl).href;
      return normalizeSiteUrl(configuredSiteUrl) === normalizeSiteUrl(githubPagesUrl);
    },
    readReleaseMarker: async (url) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Pages marker request failed with HTTP ${response.status}.`);
      return response.json() as Promise<unknown>;
    },
  };

  return {
    ...deployment,
    readRemoteState: async (branch): Promise<PagesRemoteState> => {
      const client = await github.prepareClient();
      const remote = await readRemoteTree(client, branch);
      const workflow = remote.entries.find((entry) => entry.path === config.workflowPath && entry.type === 'blob');
      const convention = remote.entries.find((entry) => entry.path === MANAGED_CONVENTION_PATH && entry.type === 'blob');
      if (!workflow || !convention) {
        throw new PagesPublisherError('Configured Pages workflow or managed convention is missing.', 409, 'PAGES_CONFLICT');
      }
      const workflowDigest = sha256(decodeBlob(await client.getBlob('pages', workflow.sha)));
      const managedConventionDigest = sha256(decodeBlob(await client.getBlob('pages', convention.sha)));
      return {
        branch,
        headSha: remote.headSha,
        workflowPath: config.workflowPath,
        workflowDigest,
        managedConventionDigest,
      };
    },
    readSealedSite: (input) => readSealedSite(input.releaseId, input.candidateDigest, input.artifactDigest),
    findExistingCommit: async (input) => {
      const client = await github.prepareClient();
      const remote = await readRemoteTree(client, input.branch);
      const marker = remote.entries.find((entry) => entry.path === 'site/_release.json' && entry.type === 'blob');
      if (!marker) return null;
      const identity = parseReleaseMarker(decodeBlob(await client.getBlob('pages', marker.sha)));
      return identity?.releaseId === input.releaseId && identity.candidateDigest === input.candidateDigest
        && identity.artifactDigest === input.artifactDigest ? remote.headSha : null;
    },
    commitSiteSubtree: async (input) => {
      const client = await github.prepareClient();
      const parentCommit = await client.getCommit('pages', input.parentCommitSha);
      const baseTreeSha = commitTreeSha(parentCommit);
      const existing = treeEntries(await client.getTree('pages', baseTreeSha, true));
      const desiredPaths = new Set(input.files.map((file) => file.path));
      const deletions = existing
        .filter((entry) => entry.path.startsWith('site/') && entry.type === 'blob' && !desiredPaths.has(entry.path))
        .map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: null }));
      const additions = await Promise.all(input.files.map(async (file) => {
        const blob = record(await client.createBlob('pages', Buffer.from(file.bytes).toString('base64'), 'base64'), 'GitHub blob creation');
        return {
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: getString(blob.sha, 'GitHub blob SHA'),
        };
      }));
      const tree = record(await client.createTree('pages', [...deletions, ...additions], baseTreeSha), 'GitHub tree creation');
      const commit = record(await client.createCommit('pages', {
        message: `Publish ${input.releaseId}`,
        tree: getString(tree.sha, 'GitHub tree SHA'),
        parents: [input.parentCommitSha],
      }), 'GitHub commit creation');
      const commitSha = getString(commit.sha, 'GitHub commit SHA');
      if (!COMMIT_PATTERN.test(commitSha)) throw new Error('GitHub commit SHA is invalid.');
      try {
        await client.updateReference('pages', input.branch, commitSha);
      } catch (error) {
        const ref = record(await client.getReference('pages', input.branch), 'Pages branch reference after commit');
        const head = record(ref.object, 'Pages branch reference object').sha;
        if (head !== commitSha) throw error;
      }
      return { commitSha, parentCommitSha: input.parentCommitSha };
    },
  };
}

export async function createProductionPagesJobRuntime(): Promise<PagesJobRuntime | null> {
  const config = readPagesRuntimeConfig();
  if (!config) return null;
  const github = await createPublishingGitHubRuntime();
  if (!github) return null;
  const adapter = createPagesAdapter(github, config);
  const publisher = createPagesPublisher(adapter, {
    withContentLock: (operation) => withRuntimeDataRootLock(() => operation(pagesTransaction())),
    deploymentJobName: config.deploymentJobName,
    deploymentStepName: config.deploymentStepName,
    releaseMarkerUrl: new URL('_release.json', `${config.pagesUrl.replace(/\/+$/, '')}/`).href,
  });
  return {
    branch: config.branch,
    workflow: config.workflow,
    workflowPath: config.workflowPath,
    expectedWorkflowDigest: config.expectedWorkflowDigest,
    expectedManagedConventionDigest: config.expectedManagedConventionDigest,
    deploymentJobName: config.deploymentJobName,
    deploymentStepName: config.deploymentStepName,
    readRelease: async (releaseId) => withRuntimeDataRootLock(() => readRelease(releaseId)),
    commit: async (input) => {
      await publisher.commit({
        release: input.release,
        snapshot: input.snapshot,
        branch: config.branch,
        workflow: config.workflow,
        workflowPath: config.workflowPath,
        expectedWorkflowDigest: config.expectedWorkflowDigest,
        expectedManagedConventionDigest: config.expectedManagedConventionDigest,
      });
    },
    captureWorkflowRun: (releaseId) => publisher.captureWorkflowRun(releaseId, {
      branch: config.branch,
      workflow: config.workflow,
    }),
    verifyAndPromote: (identity) => publisher.verifyAndPromote(identity),
    resumeRetry: async (releaseId) => {
      const service = await createEditorReleaseRetryService();
      await service.resume(releaseId);
    },
    enqueueReconcile: async (releaseId, candidateDigest, artifactDigest) => {
      await withRuntimeDataRootLock(() => {
        createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), {
          type: 'reconcile',
          input: { releaseId, candidateDigest, artifactDigest },
        });
      });
    },
  };
}
