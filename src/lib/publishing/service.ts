import { randomUUID } from 'node:crypto';
import { isBackupCaughtUp, type BackupWatermarkState } from '@/lib/jobs/watermark';
import { computeCandidateDigest, computeSelectedRevision, createCandidate } from '@/lib/publishing/snapshot';
import type { BackupProof, LivePointer, PublishScope, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

export class PublishingServiceError extends Error {
  constructor(
    message: string,
    public readonly status: 409 | 503,
    public readonly code: 'RELEASE_CONFLICT' | 'RELEASE_STALE' | 'BACKUP_REQUIRED' | 'ARTIFACT_MISMATCH'
  ) {
    super(message);
    this.name = 'PublishingServiceError';
  }
}

export interface PublishingTask {
  id: string;
  releaseId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
}

export interface PublishingInputs {
  baseSnapshot: SiteSnapshot;
  draftSnapshot: SiteSnapshot;
  generation: string;
  revision: string;
  selectedInputs: unknown;
}

export interface PublishingTransaction {
  readInputs(scope: PublishScope): PublishingInputs;
  readLivePointer(): LivePointer | null;
  readRelease(releaseId: string): { release: ReleaseRecord; snapshot: SiteSnapshot };
  listReleases(): ReleaseRecord[];
  readWatermark(): BackupWatermarkState;
  writeRelease(release: ReleaseRecord, snapshot: SiteSnapshot): void;
  persistCandidateJobs(release: ReleaseRecord, snapshot: SiteSnapshot): void;
  persistPublishTask(release: ReleaseRecord, snapshot: SiteSnapshot): PublishingTask;
  findPublishTask(releaseId: string): PublishingTask | null;
}

export interface ArtifactIdentity {
  releaseId: string;
  candidateDigest: string;
  artifactDigest: string;
}

export interface PublishingServiceOptions {
  withContentLock<T>(operation: (transaction: PublishingTransaction) => T | Promise<T>): Promise<T>;
  createId?: () => string;
  now?: () => string;
  verifyMediaHashes(snapshot: SiteSnapshot): boolean;
  verifyArtifactIdentity(release: ReleaseRecord, snapshot: SiteSnapshot): ArtifactIdentity | null;
  isBackupProofValid(proof: BackupProof | null, release: ReleaseRecord): boolean;
  retry?: (releaseId: string) => Promise<PublishingTask>;
}

const ACTIVE_STATUSES = new Set<ReleaseRecord['status']>(['publishing', 'deploying', 'verifying']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

function conflict(message: string, status: 409 | 503, code: PublishingServiceError['code']): PublishingServiceError {
  return new PublishingServiceError(message, status, code);
}

function updateRelease(release: ReleaseRecord, update: Partial<ReleaseRecord>, now: string): ReleaseRecord {
  return { ...release, ...update, updatedAt: now };
}

function isStructurallyValidProof(proof: BackupProof | null, release: ReleaseRecord): boolean {
  return proof !== null && proof.repository.trim().length > 0 && COMMIT_PATTERN.test(proof.commitSha)
    && proof.snapshotId.trim().length > 0 && DIGEST_PATTERN.test(proof.contentDigest)
    && proof.candidateDigest === release.candidateDigest && Number.isFinite(Date.parse(proof.verifiedAt));
}

function selectedRevision(inputs: PublishingInputs, scope: PublishScope, snapshot: SiteSnapshot): string {
  return computeSelectedRevision({ scope, generation: inputs.generation, selectedInputs: inputs.selectedInputs, media: snapshot.media });
}

function assertArtifactMatches(release: ReleaseRecord, artifact: ArtifactIdentity | null): void {
  if (!artifact || artifact.releaseId !== release.id || artifact.candidateDigest !== release.candidateDigest
      || artifact.artifactDigest !== release.artifactDigest) {
    throw conflict('Artifact bytes or identity do not match the sealed release.', 409, 'ARTIFACT_MISMATCH');
  }
}

export function createPublishingService(options: PublishingServiceOptions) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  function markStale(
    transaction: PublishingTransaction,
    release: ReleaseRecord,
    snapshot: SiteSnapshot,
    message: string
  ): never {
    transaction.writeRelease(updateRelease(release, {
      status: 'stale', error: { code: 'STALE_CANDIDATE', message, retryable: false },
    }, now()), snapshot);
    throw conflict(message, 409, 'RELEASE_STALE');
  }

  return {
    async createCandidate(scope: PublishScope, expectedRevision?: string): Promise<{ release: ReleaseRecord; snapshot: SiteSnapshot }> {
      return options.withContentLock((transaction) => {
        const inputs = transaction.readInputs(scope);
        if (expectedRevision !== undefined && expectedRevision !== inputs.revision) {
          throw conflict('Selected content revision changed; refresh before creating a release.', 409, 'RELEASE_CONFLICT');
        }
        const pointer = transaction.readLivePointer();
        const snapshot = createCandidate(inputs.baseSnapshot, inputs.draftSnapshot, scope);
        const timestamp = now();
        const release: ReleaseRecord = {
          schemaVersion: 1,
          id: createId(),
          scope: structuredClone(scope),
          baseLiveReleaseId: pointer?.releaseId ?? null,
          selectedRevision: selectedRevision(inputs, scope, snapshot),
          candidateDigest: computeCandidateDigest(snapshot),
          artifactDigest: null,
          status: 'building',
          backupProof: null,
          publicCommitSha: null,
          workflowRunId: null,
          workflowRunAttempt: null,
          retryFromAttempt: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.writeRelease(release, snapshot);
        transaction.persistCandidateJobs(release, snapshot);
        return { release, snapshot };
      });
    },

    async markPreviewReady(
      releaseId: string,
      result: { artifactDigest: string; backupProof: BackupProof | null }
    ): Promise<ReleaseRecord> {
      return options.withContentLock((transaction) => {
        const stored = transaction.readRelease(releaseId);
        const retryableBuildFailure = stored.release.status === 'failed'
          && stored.release.error?.code === 'PUBLIC_BUILD_FAILED'
          && stored.release.error.retryable;
        if (stored.release.status !== 'building' && stored.release.status !== 'awaiting_backup' && !retryableBuildFailure) {
          throw conflict('Release is not building a preview.', 409, 'RELEASE_CONFLICT');
        }
        if (!DIGEST_PATTERN.test(result.artifactDigest)) {
          throw conflict('Artifact digest is invalid.', 409, 'ARTIFACT_MISMATCH');
        }
        const release = updateRelease(stored.release, {
          artifactDigest: result.artifactDigest,
          backupProof: result.backupProof ? structuredClone(result.backupProof) : stored.release.backupProof,
          status: 'preview_ready',
          error: null,
        }, now());
        transaction.writeRelease(release, stored.snapshot);
        return release;
      });
    },

    async markPreviewFailed(releaseId: string, error: string): Promise<ReleaseRecord> {
      return options.withContentLock((transaction) => {
        const stored = transaction.readRelease(releaseId);
        if (stored.release.status === 'preview_ready' || stored.release.status === 'live') return stored.release;
        const release = updateRelease(stored.release, {
          status: 'failed',
          error: {
            code: 'PUBLIC_BUILD_FAILED',
            message: error.replace(/[\r\n]+/g, ' ').slice(0, 500),
            retryable: true,
          },
        }, now());
        transaction.writeRelease(release, stored.snapshot);
        return release;
      });
    },

    async confirm(
      releaseId: string,
      payload: { candidateDigest: string; artifactDigest: string }
    ): Promise<PublishingTask> {
      return options.withContentLock((transaction) => {
        const stored = transaction.readRelease(releaseId);
        const { release, snapshot } = stored;
        if (payload.candidateDigest !== release.candidateDigest || payload.artifactDigest !== release.artifactDigest
            || !release.artifactDigest || !DIGEST_PATTERN.test(release.artifactDigest)) {
          throw conflict('Confirmation identity does not match the sealed candidate and artifact.', 409, 'ARTIFACT_MISMATCH');
        }
        const existing = transaction.findPublishTask(releaseId);
        if (existing) return existing;
        if (release.status !== 'preview_ready') throw conflict('Release preview is not confirmable.', 409, 'RELEASE_CONFLICT');
        if (transaction.listReleases().some((item) => item.id !== releaseId && ACTIVE_STATUSES.has(item.status))) {
          throw conflict('Another release is already publishing.', 409, 'RELEASE_CONFLICT');
        }
        if ((transaction.readLivePointer()?.releaseId ?? null) !== release.baseLiveReleaseId) {
          return markStale(transaction, release, snapshot, 'Live release changed; rebuild the preview.');
        }

        const inputs = transaction.readInputs(release.scope);
        const currentCandidate = createCandidate(inputs.baseSnapshot, inputs.draftSnapshot, release.scope);
        if (selectedRevision(inputs, release.scope, currentCandidate) !== release.selectedRevision
            || computeCandidateDigest(currentCandidate) !== release.candidateDigest
            || computeCandidateDigest(snapshot) !== release.candidateDigest) {
          return markStale(transaction, release, snapshot, 'Selected content or referenced media changed; rebuild the preview.');
        }
        if (!options.verifyMediaHashes(snapshot)) {
          return markStale(transaction, release, snapshot, 'Referenced media bytes changed; rebuild the preview.');
        }
        assertArtifactMatches(release, options.verifyArtifactIdentity(release, snapshot));
        if (!isBackupCaughtUp(transaction.readWatermark())) {
          throw conflict('Global content backup is not caught up.', 503, 'BACKUP_REQUIRED');
        }
        if (!isStructurallyValidProof(release.backupProof, release)
            || !options.isBackupProofValid(release.backupProof, release)) {
          throw conflict('A valid backup proof for this candidate is required.', 503, 'BACKUP_REQUIRED');
        }

        const authorized = updateRelease(release, { status: 'publishing', error: null }, now());
        transaction.writeRelease(authorized, snapshot);
        return transaction.persistPublishTask(authorized, snapshot);
      });
    },

    async withdraw(articleId: string): Promise<{ release: ReleaseRecord; snapshot: SiteSnapshot }> {
      return this.createCandidate({ kind: 'article', articleId, action: 'withdraw' });
    },

    async retry(releaseId: string): Promise<PublishingTask> {
      if (!options.retry) throw conflict('Release retry is not configured.', 409, 'RELEASE_CONFLICT');
      return options.retry(releaseId);
    },

    async assertBaseLive(releaseId: string): Promise<void> {
      return options.withContentLock((transaction) => {
        const { release, snapshot } = transaction.readRelease(releaseId);
        if ((transaction.readLivePointer()?.releaseId ?? null) !== release.baseLiveReleaseId) {
          markStale(transaction, release, snapshot, 'Live release changed; rebuild the preview.');
        }
      });
    },
  };
}
