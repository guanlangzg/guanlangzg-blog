import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { BackupProof, LivePointer, SiteSnapshot } from '@/lib/publishing/types';
import type { SiteSettings } from '@/lib/site-settings';
import { createJobUnderLock, createOrReuseActiveJobUnderLock, type JobRecord } from '@/lib/jobs/store';
import { readGitHubConnection, type GitHubRepositories } from '@/lib/github/config';
import { GitHubAppTokenManager, type GitHubTokenProvider } from '@/lib/github/app';
import { GitHubRestClient } from '@/lib/github/client';
import {
  readArticlesFromDisk,
  readNavigationFromDisk,
  readSiteSettingsFromDisk,
} from '@/lib/editor-data-storage';
import {
  readEditorMediaFile,
  readEditorMediaManifest,
  type EditorMediaAsset,
  type EditorMediaManifest,
} from '@/lib/editor-media-storage';
import { createNavigationIdentityMap, type NavigationIdentityMap } from '@/lib/navigation-identities';
import { readBackupWatermarkUnderLock } from '@/lib/jobs/watermark';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { readLivePointer, readNavigationIdentities, readRelease, writeRelease } from '@/lib/publishing/store';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { createBackupSnapshotId, writeGitHubBackup, type BackupSnapshotInput } from '@/lib/github/backup';

interface WorkflowFormat {
  schemaVersion: 1;
  siteId: string;
}

interface CaptureOptions {
  snapshotId?: string;
  reason?: string;
  contentSequence?: number;
  generation?: string;
  candidateReleaseId?: string;
  livePointer?: LivePointer;
}

interface CapturedSnapshot {
  input: BackupSnapshotInput;
  candidateReleaseId: string | null;
}

interface GitHubBackupClientOptions {
  fetch?: typeof fetch;
  tokenProvider?: GitHubTokenProvider;
}

const CANDIDATE_RELEASE_STATUSES = new Set(['awaiting_backup', 'building', 'preview_ready']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function readOrCreateWorkflowFormat(): WorkflowFormat {
  const workflowRoot = path.join(getRuntimeDataRootPath(), 'workflow');
  const filePath = path.join(workflowRoot, 'format.json');
  if (!fs.existsSync(filePath)) {
    const format: WorkflowFormat = { schemaVersion: 1, siteId: randomUUID() };
    fs.mkdirSync(workflowRoot, { recursive: true, mode: 0o700 });
    writeJsonAtomically(filePath, format, { mode: 0o600 });
    return format;
  }

  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workflow format is invalid.');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.siteId !== 'string' || !record.siteId.trim()
      || Object.keys(record).some((key) => key !== 'schemaVersion' && key !== 'siteId')) {
    throw new Error('Workflow format is invalid or unsupported.');
  }
  return { schemaVersion: 1, siteId: record.siteId };
}

function readCandidateRelease(candidateReleaseId?: string): {
  releaseId: string;
  snapshot: SiteSnapshot;
  candidateDigest: string;
} | null {
  const releasesRoot = path.join(getRuntimeDataRootPath(), 'workflow', 'releases');
  const releaseIds = candidateReleaseId
    ? [candidateReleaseId]
    : fs.existsSync(releasesRoot)
      ? fs.readdirSync(releasesRoot).filter((name) => SAFE_ID_PATTERN.test(name))
      : [];
  const candidates: Array<{
    releaseId: string;
    release: ReturnType<typeof readRelease>['release'];
    snapshot: SiteSnapshot;
  }> = [];
  for (const releaseId of releaseIds) {
    try {
      const stored = readRelease(releaseId);
      if (CANDIDATE_RELEASE_STATUSES.has(stored.release.status)) candidates.push({ releaseId, ...stored });
    } catch (error) {
      if (candidateReleaseId || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  candidates.sort((left, right) => right.release.updatedAt.localeCompare(left.release.updatedAt));
  const selected = candidates[0];
  if (!selected) {
    if (candidateReleaseId) throw new Error('Requested backup candidate release is not available.');
    return null;
  }
  if (computeCandidateDigest(selected.snapshot) !== selected.release.candidateDigest) {
    throw new Error('Stored backup candidate digest does not match its frozen snapshot.');
  }
  return {
    releaseId: selected.releaseId,
    snapshot: selected.snapshot,
    candidateDigest: selected.release.candidateDigest,
  };
}

async function readMediaObjects(manifest: EditorMediaManifest): Promise<Array<{ assetPath: string; bytes: Uint8Array }>> {
  return Promise.all(manifest.assets.map(async (asset) => {
    const bytes = await readEditorMediaFile(asset);
    if (!bytes) throw new Error(`Managed media bytes are missing: ${asset.path}`);
    return { assetPath: asset.path, bytes };
  }));
}

function toBackupMediaAsset(asset: SiteSnapshot['media'][number], frozenRelease: ReturnType<typeof readRelease>['release']): EditorMediaAsset {
  const timestamp = frozenRelease.updatedAt;
  return {
    id: asset.sha256,
    path: asset.originalPath,
    publicPath: asset.publicPath,
    mimeType: asset.mimeType as EditorMediaAsset['mimeType'],
    size: asset.size,
    hash: asset.sha256,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function captureCurrentSnapshot(options: CaptureOptions = {}): Promise<CapturedSnapshot> {
  return withRuntimeDataRootLock(async () => {
    const root = getRuntimeDataRootPath();
    const articles: Article[] = readArticlesFromDisk();
    const navigation: Category[] = readNavigationFromDisk();
    const settings: SiteSettings = readSiteSettingsFromDisk();
    const currentMediaManifest = readEditorMediaManifest();
    let mediaManifest = currentMediaManifest;
    const mediaByPath = new Map(currentMediaManifest.assets.map((asset) => [asset.path, asset]));
    const mediaObjectsByPath = new Map((await readMediaObjects(currentMediaManifest)).map((item) => [item.assetPath, item.bytes]));
    const watermark = readBackupWatermarkUnderLock(root);
    const live: LivePointer | null = options.livePointer ?? readLivePointer();
    let liveSnapshot: SiteSnapshot | null = null;
    if (options.livePointer) {
      if (!options.livePointer || typeof options.livePointer !== 'object'
        || !SAFE_ID_PATTERN.test(options.livePointer.releaseId)
        || options.livePointer.schemaVersion !== 1
        || !/^[a-f0-9]{64}$/i.test(options.livePointer.candidateDigest)
        || !/^[a-f0-9]{64}$/i.test(options.livePointer.artifactDigest)
        || !/^[a-f0-9]{40}$/i.test(options.livePointer.publicCommitSha)
        || !Number.isSafeInteger(options.livePointer.workflowRunId) || options.livePointer.workflowRunId <= 0
        || !Number.isSafeInteger(options.livePointer.workflowRunAttempt) || options.livePointer.workflowRunAttempt <= 0
        || typeof options.livePointer.verifiedAt !== 'string'
        || !Number.isFinite(Date.parse(options.livePointer.verifiedAt))
        || new Date(options.livePointer.verifiedAt).toISOString() !== options.livePointer.verifiedAt) {
        throw new Error('Requested live pointer is invalid.');
      }
      const frozen = readRelease(options.livePointer.releaseId);
      const release = frozen.release;
      if (release.status !== 'live'
        || computeCandidateDigest(frozen.snapshot) !== options.livePointer.candidateDigest
        || release.candidateDigest !== options.livePointer.candidateDigest
        || release.artifactDigest !== options.livePointer.artifactDigest
        || release.publicCommitSha !== options.livePointer.publicCommitSha
        || release.workflowRunId !== options.livePointer.workflowRunId
        || release.workflowRunAttempt !== options.livePointer.workflowRunAttempt) {
        throw new Error('Requested live pointer does not match its frozen release.');
      }
      liveSnapshot = frozen.snapshot;
      for (const media of frozen.snapshot.media) {
        const frozenAsset = toBackupMediaAsset(media, release);
        const currentAsset = mediaByPath.get(frozenAsset.path);
        if (currentAsset && (currentAsset.hash !== frozenAsset.hash || currentAsset.size !== frozenAsset.size)) {
          throw new Error(`Current media conflicts with frozen live snapshot: ${frozenAsset.path}`);
        }
        if (!currentAsset) mediaByPath.set(frozenAsset.path, frozenAsset);
        if (!mediaObjectsByPath.has(frozenAsset.path)) {
          const bytes = await readEditorMediaFile(frozenAsset);
          if (!bytes) throw new Error(`Frozen live media bytes are missing: ${frozenAsset.path}`);
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (bytes.byteLength !== frozenAsset.size || digest !== frozenAsset.hash) {
            throw new Error(`Frozen live media bytes do not match snapshot: ${frozenAsset.path}`);
          }
          mediaObjectsByPath.set(frozenAsset.path, bytes);
        }
      }
      mediaManifest = { ...currentMediaManifest, assets: [...mediaByPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
    } else {
      liveSnapshot = live ? readRelease(live.releaseId).snapshot : null;
    }
    const candidate = options.livePointer ? null : readCandidateRelease(options.candidateReleaseId);
    const identities: NavigationIdentityMap = readNavigationIdentities() ?? createNavigationIdentityMap(navigation);
    const workflowFormat = readOrCreateWorkflowFormat();

    return {
      candidateReleaseId: candidate?.releaseId ?? null,
      input: {
        snapshotId: options.snapshotId ?? createBackupSnapshotId(),
        siteId: workflowFormat.siteId,
        articles,
        navigation,
        navigationIdentities: identities,
        settings,
        mediaManifest,
        mediaObjects: [...mediaObjectsByPath.entries()].map(([assetPath, bytes]) => ({ assetPath, bytes })),
        publication: {
          live,
          liveSnapshot,
          candidate: candidate ? { snapshot: candidate.snapshot, candidateDigest: candidate.candidateDigest } : null,
        },
        reason: options.reason ?? 'content-snapshot',
        contentSequence: options.contentSequence ?? watermark.contentSequence,
        generation: options.generation ?? watermark.generation,
      },
    };
  });
}

export async function createCurrentGitHubBackupSnapshotInput(options: CaptureOptions = {}): Promise<BackupSnapshotInput> {
  return (await captureCurrentSnapshot(options)).input;
}

export async function enqueueCurrentGitHubBackup(options: {
  reason: string;
  candidateReleaseId?: string;
  now?: Date;
}): Promise<JobRecord> {
  return withRuntimeDataRootLock(() => {
    const root = getRuntimeDataRootPath();
    const watermark = readBackupWatermarkUnderLock(root);
    const selectedCandidate = readCandidateRelease(options.candidateReleaseId);
    const input = {
      generation: watermark.generation,
      contentSequence: watermark.contentSequence,
      reason: options.reason,
      snapshotId: createBackupSnapshotId(),
      ...(selectedCandidate ? { candidateReleaseId: selectedCandidate.releaseId } : {}),
    };
    return createJobUnderLock(root, { type: 'backup', input, ...(options.now ? { now: options.now } : {}) });
  });
}

export interface RemoteBackupCommit {
  commitSha: string;
  committedAt: string;
  digest: string | null;
}

export async function listRemoteGitHubBackups(options: { cursor: string | null; limit: number }): Promise<{
  items: RemoteBackupCommit[];
  nextCursor: string | null;
}> {
  const client = await createConfiguredGitHubBackupClient();
  const commits = await client.listCommits('backup', { page: options.cursor ? Number(options.cursor) : 1, perPage: options.limit + 1 });
  if (!Array.isArray(commits)) throw new Error('GitHub backup commit list response is invalid.');
  const items = commits.slice(0, options.limit).map((value): RemoteBackupCommit => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub backup commit entry is invalid.');
    const record = value as Record<string, unknown>;
    const commit = record.commit as Record<string, unknown> | undefined;
    const author = commit?.author as Record<string, unknown> | undefined;
    if (typeof record.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(record.sha)
      || typeof author?.date !== 'string' || !Number.isFinite(Date.parse(author.date))) {
      throw new Error('GitHub backup commit entry is invalid.');
    }
    return { commitSha: record.sha, committedAt: new Date(author.date).toISOString(), digest: null };
  });
  return { items, nextCursor: commits.length > options.limit ? String((options.cursor ? Number(options.cursor) : 1) + 1) : null };
}

export async function createConfiguredGitHubBackupClient(options: GitHubBackupClientOptions = {}): Promise<GitHubRestClient> {
  const connection = await readGitHubConnection();
  if (!connection || connection.status !== 'connected') throw new Error('GitHub backup connection is not ready.');
  const repositories: GitHubRepositories = connection.repos;
  const tokenProvider = options.tokenProvider ?? new GitHubAppTokenManager({
    appId: connection.appId,
    installationId: connection.installationId,
    repositories,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new GitHubRestClient({ repositories, tokenProvider, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

export async function persistVerifiedGitHubBackupProof(
  proof: BackupProof,
  candidateReleaseId: string | null = null,
): Promise<void> {
  if (!SAFE_ID_PATTERN.test(proof.snapshotId)) throw new Error('Backup proof snapshot ID is invalid.');
  await withRuntimeDataRootLock(() => {
    const root = getRuntimeDataRootPath();
    let candidateRelease: ReturnType<typeof readRelease>['release'] | null = null;
    let candidateSnapshot: SiteSnapshot | null = null;
    if (candidateReleaseId) {
      const stored = readRelease(candidateReleaseId);
      const expectedDigest = computeCandidateDigest(stored.snapshot);
      if (!CANDIDATE_RELEASE_STATUSES.has(stored.release.status)) {
        throw new Error('Backup candidate release is not available for proof persistence.');
      }
      if (stored.release.candidateDigest !== expectedDigest || proof.candidateDigest !== expectedDigest) {
        throw new Error('Backup proof does not match the frozen candidate release.');
      }
      candidateRelease = { ...stored.release, backupProof: proof, updatedAt: proof.verifiedAt };
      candidateSnapshot = stored.snapshot;
      writeRelease(candidateRelease, candidateSnapshot);
    }

    const proofDirectory = path.join(root, 'workflow', 'backup-proofs');
    fs.mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
    writeJsonAtomically(path.join(proofDirectory, `${proof.snapshotId}.json`), proof, { mode: 0o600 });

    if (candidateRelease && candidateSnapshot && candidateRelease.status !== 'preview_ready') {
      createOrReuseActiveJobUnderLock(root, {
        type: 'build',
        id: `build-${candidateRelease.id}`,
        input: { releaseId: candidateRelease.id, candidateDigest: candidateRelease.candidateDigest },
      });
    }
  });
}

export function createGitHubBackupJobHandler(client: GitHubRestClient) {
  return async (job: JobRecord): Promise<{ remoteCommit: string; verifiedFullBackup?: true }> => {
    if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) {
      throw new Error('GitHub backup job input is invalid.');
    }
    const input = job.input as Record<string, unknown>;
    const isLivePointerJob = input.reason === 'live-pointer';
    if (isLivePointerJob && (!input.pointer || typeof input.pointer !== 'object' || Array.isArray(input.pointer))) {
      throw new Error('Live pointer backup job requires a valid pointer.');
    }
    const pointer = isLivePointerJob ? input.pointer as LivePointer : undefined;
    const hasWatermark = typeof input.generation === 'string'
      && Number.isSafeInteger(input.contentSequence)
      && Number(input.contentSequence) >= 0;
    const captured = await captureCurrentSnapshot({
      snapshotId: typeof input.snapshotId === 'string' ? input.snapshotId : `job-${job.id}`,
      reason: typeof input.reason === 'string' ? input.reason : undefined,
      generation: hasWatermark ? input.generation as string : undefined,
      contentSequence: hasWatermark ? input.contentSequence as number : undefined,
      candidateReleaseId: typeof input.candidateReleaseId === 'string' ? input.candidateReleaseId : undefined,
      ...(pointer ? { livePointer: pointer } : {}),
    });
    const proof = await writeGitHubBackup(client, captured.input, {
      persistProof: async (verifiedProof) => {
        if (!isLivePointerJob) await persistVerifiedGitHubBackupProof(verifiedProof, captured.candidateReleaseId);
      },
    });
    if (proof.snapshotId !== captured.input.snapshotId) throw new Error('Verified GitHub backup proof has an unexpected snapshot ID.');
    const canAdvanceGlobalWatermark = !isLivePointerJob
      && hasWatermark
      && !captured.candidateReleaseId
      && captured.input.generation === input.generation
      && captured.input.contentSequence === input.contentSequence;
    return {
      remoteCommit: proof.commitSha,
      ...(canAdvanceGlobalWatermark ? { verifiedFullBackup: true as const } : {}),
    };
  };
}
