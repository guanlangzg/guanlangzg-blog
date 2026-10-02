import type { BackupWatermarkState } from '@/lib/jobs/watermark';
import type { BackupProof, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import type { PagesVerificationResult } from '@/lib/publishing/pages';
import type { PublishingTask } from '@/lib/publishing/service';

export class ReleaseRetryError extends Error {
  constructor(
    message: string,
    public readonly status: 409 | 503,
    public readonly code: 'RETRY_CONFLICT' | 'BACKUP_REQUIRED'
  ) {
    super(message);
    this.name = 'ReleaseRetryError';
  }
}

export interface RetryInputs {
  selectedRevision: string;
  baseLiveReleaseId: string | null;
}

export interface RetryTransaction {
  readRelease(releaseId: string): { release: ReleaseRecord; snapshot: SiteSnapshot };
  writeRelease(release: ReleaseRecord, snapshot: SiteSnapshot): void;
  readLiveReleaseId(): string | null;
  readInputs(release: ReleaseRecord): RetryInputs;
  readWatermark(): BackupWatermarkState;
  isBackupProofValid(proof: BackupProof | null, release: ReleaseRecord): boolean;
  verifyArtifactIdentity(release: ReleaseRecord, snapshot: SiteSnapshot): boolean;
  persistPublishTask(release: ReleaseRecord, snapshot: SiteSnapshot): PublishingTask;
  findPublishTask(releaseId: string): PublishingTask | null;
}

export interface RetryAdapter {
  withContentLock<T>(operation: (transaction: RetryTransaction) => T | Promise<T>): Promise<T>;
  verifyArtifactTree(release: ReleaseRecord): Promise<{ releaseId: string; candidateDigest: string; artifactDigest: string } | null>;
  verifyRetryPreconditions(release: ReleaseRecord): Promise<boolean>;
  getLatestAttempt(runId: number): Promise<number>;
  rerunWorkflow(runId: number): Promise<void>;
}

export interface ReleaseRetryOptions {
  adapter: RetryAdapter;
  verifyDeployment?: (release: ReleaseRecord, snapshot: SiteSnapshot) => Promise<PagesVerificationResult>;
  now?: () => string;
}

interface RetryPreparation {
  release: ReleaseRecord;
  snapshot: SiteSnapshot;
  task: PublishingTask;
  firstAttempt: boolean;
  authorizedTask: boolean;
}

function conflict(message: string): ReleaseRetryError {
  return new ReleaseRetryError(message, 409, 'RETRY_CONFLICT');
}

function backupRequired(message: string): ReleaseRetryError {
  return new ReleaseRetryError(message, 503, 'BACKUP_REQUIRED');
}

function updateRelease(release: ReleaseRecord, update: Partial<ReleaseRecord>, now: string): ReleaseRecord {
  return { ...release, ...update, updatedAt: now };
}

function isRetryActive(release: ReleaseRecord): boolean {
  return release.retryFromAttempt !== null && (release.status === 'deploying' || release.status === 'verifying')
    && (release.error?.code === 'RETRY_PENDING' || release.error?.code === 'RETRY_POSTING' || release.error?.code === 'PENDING_VERIFICATION');
}

export function createReleaseRetryService(options: ReleaseRetryOptions) {
  const now = options.now ?? (() => new Date().toISOString());

  async function updateRetryState(
    releaseId: string,
    expectedRetryFrom: number,
    update: (release: ReleaseRecord) => Partial<ReleaseRecord> | null
  ): Promise<ReleaseRecord | null> {
    return options.adapter.withContentLock((transaction) => {
      const stored = transaction.readRelease(releaseId);
      if (stored.release.retryFromAttempt !== expectedRetryFrom) return null;
      const changes = update(stored.release);
      if (changes === null) return null;
      const next = updateRelease(stored.release, changes, now());
      transaction.writeRelease(next, stored.snapshot);
      return next;
    });
  }

  async function markPending(
    releaseId: string,
    expectedRetryFrom: number,
    message: string,
    code = 'PENDING_VERIFICATION',
    status: ReleaseRecord['status'] = 'verifying'
  ): Promise<void> {
    await updateRetryState(releaseId, expectedRetryFrom, (release) => {
      if (release.status === 'live' || release.status === 'failed') return {};
      if (release.error?.code === 'PENDING_VERIFICATION' && code === 'PENDING_VERIFICATION') return {};
      const preservePostIntent = release.error?.code === 'RETRY_POSTING'
        && (code === 'PENDING_VERIFICATION' || code === 'PENDING_VERIFICATION');
      return { status, error: preservePostIntent ? release.error : { code, message, retryable: true } };
    });
  }

  async function prepare(releaseId: string, authorizedTask: boolean): Promise<RetryPreparation> {
    return options.adapter.withContentLock((transaction) => {
      const { release, snapshot } = transaction.readRelease(releaseId);
      if (isRetryActive(release)) {
        const task = transaction.findPublishTask(releaseId);
        if (!task) throw conflict('An active retry placeholder exists without its publish task.');
        return { release, snapshot, task, firstAttempt: false, authorizedTask: false };
      }
      if (release.status !== 'failed' || !release.error || release.error.retryable !== true
          || !release.publicCommitSha || !release.workflowRunId || !release.workflowRunAttempt) {
        throw conflict('Only a determined retryable deployment failure can be rerun.');
      }
      const inputs = transaction.readInputs(release);
      if (inputs.selectedRevision !== release.selectedRevision || inputs.baseLiveReleaseId !== release.baseLiveReleaseId
          || transaction.readLiveReleaseId() !== release.baseLiveReleaseId) {
        throw conflict('Selected inputs or the live baseline changed; create a new release preview.');
      }
      if (!authorizedTask && (!transaction.isBackupProofValid(release.backupProof, release)
          || !transaction.verifyArtifactIdentity(release, snapshot))) {
        throw backupRequired('The candidate backup proof or sealed artifact is invalid.');
      }
      const retryFromAttempt = release.workflowRunAttempt;
      const pending = updateRelease(release, {
        status: 'deploying',
        retryFromAttempt,
        error: { code: 'RETRY_PENDING', message: 'The same workflow run is being reconciled.', retryable: true },
      }, now());
      transaction.writeRelease(pending, snapshot);
      const task = transaction.persistPublishTask(pending, snapshot);
      return { release: pending, snapshot, task, firstAttempt: true, authorizedTask };
    });
  }

  async function saveAttempt(preparation: RetryPreparation, attempt: number): Promise<RetryPreparation | null> {
    const retryFrom = preparation.release.retryFromAttempt;
    if (retryFrom === null || attempt <= retryFrom) return preparation;
    const release = await updateRetryState(preparation.release.id, retryFrom, (current) => {
      if (!isRetryActive(current)) return null;
      return { workflowRunAttempt: attempt, status: 'deploying', error: null };
    });
    return release ? { ...preparation, release } : null;
  }

  async function reconcileAttempt(preparation: RetryPreparation, allowPost: boolean): Promise<void> {
    const retryFrom = preparation.release.retryFromAttempt;
    const runId = preparation.release.workflowRunId;
    if (retryFrom === null || runId === null) return;

    let attempt: number;
    try {
      attempt = await options.adapter.getLatestAttempt(runId);
    } catch {
      await markPending(preparation.release.id, retryFrom, 'Latest run attempt could not be queried.');
      return;
    }
    if (!Number.isSafeInteger(attempt) || attempt < retryFrom) {
      await markPending(preparation.release.id, retryFrom, 'The latest run attempt is inconsistent; retry remains pending.');
      return;
    }
    if (attempt === retryFrom) {
      const identityValid = await verifyTreeOutsideLock(preparation.release);
      if (!identityValid) {
        const latest = await options.adapter.withContentLock((transaction) => transaction.readRelease(preparation.release.id).release);
        if (preparation.firstAttempt && latest.status === 'deploying' && latest.error?.code === 'RETRY_PENDING') {
          await updateRetryState(preparation.release.id, retryFrom, (current) => current.error?.code === 'RETRY_PENDING'
            ? { status: 'failed', retryFromAttempt: null, error: { code: 'ARTIFACT_INVALID', message: 'The sealed artifact tree is invalid.', retryable: false } }
            : null);
          throw backupRequired('The sealed artifact tree is invalid.');
        }
        return;
      }
      if (!allowPost) {
        await markPending(preparation.release.id, retryFrom, 'The rerun acceptance is unknown; no second POST was sent.');
        return;
      }
      const posting = await updateRetryState(preparation.release.id, retryFrom, (current) => {
        if (!isRetryActive(current) || current.error?.code !== 'RETRY_PENDING'
            || current.workflowRunAttempt !== retryFrom) return null;
        return { status: 'deploying', error: { code: 'RETRY_POSTING', message: 'The rerun request may have been sent; reconcile the same run.', retryable: true } };
      });
      if (!posting) return;
      try {
        await options.adapter.rerunWorkflow(runId);
      } catch {
        await markPending(preparation.release.id, retryFrom, 'The rerun response is unknown; only attempt lookup is safe.', 'PENDING_VERIFICATION', 'deploying');
        return;
      }
      try {
        attempt = await options.adapter.getLatestAttempt(runId);
      } catch {
        await markPending(preparation.release.id, retryFrom, 'The rerun response is unknown; only attempt lookup is safe.', 'PENDING_VERIFICATION', 'deploying');
        return;
      }
      if (attempt <= retryFrom) {
        await markPending(preparation.release.id, retryFrom, 'The rerun request was sent but its new attempt is not visible yet.', 'PENDING_VERIFICATION', 'deploying');
        return;
      }
    }

    const updated = await saveAttempt(preparation, attempt);
    if (!updated || !options.verifyDeployment) return;
    let result: PagesVerificationResult;
    try {
      result = await options.verifyDeployment(updated.release, updated.snapshot);
    } catch {
      await markPending(preparation.release.id, retryFrom, 'The new workflow attempt remains pending verification.');
      return;
    }
    if (result.kind === 'live') {
      await markPending(preparation.release.id, retryFrom, 'Pages verification succeeded; live promotion must be persisted by the Pages transaction.', 'PENDING_VERIFICATION', 'deploying');
    } else if (result.kind === 'failed') {
      await updateRetryState(preparation.release.id, retryFrom, (current) => {
        if (current.workflowRunAttempt !== attempt || current.status === 'live') return {};
        return { status: 'failed', error: { code: result.code, message: result.message, retryable: true } };
      });
    } else {
      await markPending(preparation.release.id, retryFrom, result.message);
    }
  }

  async function verifyTreeOutsideLock(release: ReleaseRecord): Promise<boolean> {
    let manifest: { releaseId: string; candidateDigest: string; artifactDigest: string } | null;
    try {
      manifest = await options.adapter.verifyArtifactTree(release);
    } catch {
      manifest = null;
    }
    return Boolean(manifest && manifest.releaseId === release.id
      && manifest.candidateDigest === release.candidateDigest
      && manifest.artifactDigest === release.artifactDigest);
  }

  return {
    async retry(releaseId: string): Promise<PublishingTask> {
      const current = await options.adapter.withContentLock((transaction) => transaction.readRelease(releaseId));
      if (!isRetryActive(current.release) && !await options.adapter.verifyRetryPreconditions(current.release)) {
        throw conflict('Pages branch head or managed workflow changed; retry is refused.');
      }

      const preparation = await prepare(releaseId, isRetryActive(current.release));
      if (preparation.firstAttempt && !await verifyTreeOutsideLock(preparation.release)) {
        await updateRetryState(releaseId, preparation.release.retryFromAttempt!, (latest) => latest.error?.code === 'RETRY_PENDING'
          ? { status: 'failed', retryFromAttempt: null, error: { code: 'ARTIFACT_INVALID', message: 'The sealed artifact tree is invalid.', retryable: false } }
          : null);
        throw backupRequired('The sealed artifact tree is invalid.');
      }
      await reconcileAttempt(preparation, preparation.release.error?.code === 'RETRY_PENDING');
      return preparation.task;
    },

    async resume(releaseId: string): Promise<PublishingTask | null> {
      const preparation = await options.adapter.withContentLock((transaction) => {
        const { release, snapshot } = transaction.readRelease(releaseId);
        if (!isRetryActive(release)) return null;
        const task = transaction.findPublishTask(releaseId);
        if (!task) throw conflict('An active retry placeholder exists without its publish task.');
        return { release, snapshot, task, firstAttempt: false, authorizedTask: true };
      });
      if (!preparation) return null;
      await reconcileAttempt(preparation, preparation.release.error?.code === 'RETRY_PENDING');
      return preparation.task;
    },

    async recordVerificationOutcome<T>(releaseId: string, verify: () => Promise<T>): Promise<T | 'pending_verification'> {
      try {
        return await verify();
      } catch {
        const current = await options.adapter.withContentLock((transaction) => transaction.readRelease(releaseId));
        if (current.release.retryFromAttempt !== null) {
          await markPending(releaseId, current.release.retryFromAttempt, 'Deployment verification is pending.');
        }
        return 'pending_verification';
      }
    },
  };
}
