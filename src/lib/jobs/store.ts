import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { createArtifactManifest } from '@/lib/public-build/runner';
import { readLivePointer, readRelease } from '@/lib/publishing/store';
import type { ReleaseRecord } from '@/lib/publishing/types';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { sha256Hex, stableJsonStringify } from '@/lib/stable-json';

export const JOB_TYPES = ['backup', 'build', 'publish', 'reconcile', 'restore', 'github-check'] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = 'pending' | 'retry' | 'running' | 'succeeded' | 'failed';

export interface JobRecord {
    id: string;
    type: JobType;
    inputDigest: string;
    input: unknown;
    status: JobStatus;
    attempt: number;
    nextAttemptAt: string;
    claimedAt: string | null;
    claimToken?: string;
    remoteCommit: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 5 * 60_000;
export const MAX_JOB_ATTEMPTS = 11;
export const DEFAULT_JOB_LEASE_MS = 2 * 60_000;

function jobsDirectory(root: string): string {
    return path.join(root, 'workflow', 'jobs');
}

function jobFilePath(root: string, id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error('Invalid job id.');
    }

    return path.join(jobsDirectory(root), `${id}.json`);
}

function isJobType(value: unknown): value is JobType {
    return typeof value === 'string' && (JOB_TYPES as readonly string[]).includes(value);
}

function parseJob(value: unknown): JobRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const job = value as Partial<JobRecord>;
    if (
        typeof job.id !== 'string' || !isJobType(job.type) ||
        typeof job.inputDigest !== 'string' || typeof job.input !== 'object' && typeof job.input !== 'string' && typeof job.input !== 'number' && typeof job.input !== 'boolean' && job.input !== null ||
        !['pending', 'retry', 'running', 'succeeded', 'failed'].includes(job.status ?? '') ||
        !Number.isSafeInteger(job.attempt) || (job.attempt ?? -1) < 0 ||
        typeof job.nextAttemptAt !== 'string' ||
        !(job.claimedAt === null || typeof job.claimedAt === 'string') ||
        !(job.remoteCommit === null || typeof job.remoteCommit === 'string') ||
        !(job.lastError === null || typeof job.lastError === 'string') ||
        typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string'
    ) {
        return null;
    }

    return job as JobRecord;
}

export function createJobUnderLock(
    root: string,
    input: { type: JobType; input: unknown; id?: string; now?: Date }
): JobRecord {
    if (!isJobType(input.type)) {
        throw new Error(`Unsupported job type: ${String(input.type)}`);
    }

    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const job: JobRecord = {
        id: input.id ?? randomUUID(),
        type: input.type,
        inputDigest: sha256Hex(stableJsonStringify(input.input)),
        input: input.input,
        status: 'pending',
        attempt: 0,
        nextAttemptAt: timestamp,
        claimedAt: null,
        remoteCommit: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    writeJsonAtomically(jobFilePath(root, job.id), job);
    return job;
}

export async function createJob(input: {
    type: JobType;
    input: unknown;
    id?: string;
    now?: Date;
}): Promise<JobRecord> {
    return withRuntimeDataRootLock(() =>
        createJobUnderLock(getRuntimeDataRootPath(), input)
    );
}

/** Reuses an unfinished equivalent task so repeated UI clicks do not duplicate remote checks. */
export function createOrReuseActiveJobUnderLock(
    root: string,
    input: { type: JobType; input: unknown; id?: string; now?: Date }
): JobRecord {
    const digest = sha256Hex(stableJsonStringify(input.input));
    const jobs = listJobsUnderLock(root);
    const existing = jobs.find((job) =>
        job.type === input.type && job.inputDigest === digest &&
        (job.status === 'pending' || job.status === 'retry' || job.status === 'running')
    );
    if (existing) return existing;

    if (input.id && jobs.some((job) => job.id === input.id)) {
        return createJobUnderLock(root, { ...input, id: undefined });
    }
    return createJobUnderLock(root, input);
}

export async function createOrReuseActiveJob(input: {
    type: JobType;
    input: unknown;
    id?: string;
    now?: Date;
}): Promise<JobRecord> {
    return withRuntimeDataRootLock(() =>
        createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), input)
    );
}

function readJobFile(filePath: string): JobRecord {
    const job = parseJob(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
    if (!job) {
        throw new Error(`Invalid persisted job: ${filePath}`);
    }

    return job;
}

export function listJobsUnderLock(root: string): JobRecord[] {
    const directory = jobsDirectory(root);
    if (!fs.existsSync(directory)) {
        return [];
    }

    return fs.readdirSync(directory)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => readJobFile(path.join(directory, fileName)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

const CANDIDATE_BUILD_STATUSES = new Set(['building', 'awaiting_backup']);
const SAFE_BACKUP_SNAPSHOT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const HEX_SHA1 = /^[a-f0-9]{40}$/i;

function hasPersistedCandidateProof(root: string, release: {
    candidateDigest: string;
    backupProof: { repository: string; commitSha: string; snapshotId: string; contentDigest: string; candidateDigest: string; verifiedAt: string } | null;
}): boolean {
    const proof = release.backupProof;
    if (!proof || proof.candidateDigest !== release.candidateDigest
        || !proof.repository.trim() || !HEX_SHA1.test(proof.commitSha)
        || !SAFE_BACKUP_SNAPSHOT_ID.test(proof.snapshotId) || !HEX_SHA256.test(proof.contentDigest)
        || !Number.isFinite(Date.parse(proof.verifiedAt))) {
        return false;
    }

    const proofPath = path.join(root, 'workflow', 'backup-proofs', `${proof.snapshotId}.json`);
    try {
        const stored = JSON.parse(fs.readFileSync(proofPath, 'utf8')) as Partial<typeof proof>;
        return stored.repository === proof.repository
            && stored.commitSha === proof.commitSha
            && stored.snapshotId === proof.snapshotId
            && stored.contentDigest === proof.contentDigest
            && stored.candidateDigest === proof.candidateDigest
            && stored.verifiedAt === proof.verifiedAt;
    } catch {
        return false;
    }
}

function hasValidReleaseDigests(release: { candidateDigest: string; artifactDigest: string | null }, snapshot: unknown): release is { candidateDigest: string; artifactDigest: string } {
    return typeof release.artifactDigest === 'string'
        && HEX_SHA256.test(release.candidateDigest)
        && HEX_SHA256.test(release.artifactDigest)
        && computeCandidateDigest(snapshot as Parameters<typeof computeCandidateDigest>[0]) === release.candidateDigest;
}

function hasActiveReleaseJob(
    jobs: JobRecord[],
    type: JobType,
    identity: { releaseId: string; candidateDigest: string; artifactDigest: string }
): boolean {
    return jobs.some((job) => {
        if (job.type !== type || !['pending', 'retry', 'running'].includes(job.status)) return false;
        if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return false;
        const input = job.input as Record<string, unknown>;
        return input.releaseId === identity.releaseId
            && input.candidateDigest === identity.candidateDigest
            && input.artifactDigest === identity.artifactDigest;
    });
}

type ArtifactManifestFactory = typeof createArtifactManifest;
let artifactManifestFactory: ArtifactManifestFactory = createArtifactManifest;

export function setArtifactManifestFactoryForTests(factory: typeof createArtifactManifest | null): void {
    artifactManifestFactory = factory ?? createArtifactManifest;
}

interface PublicationRecoverySnapshot {
    releaseId: string;
    release: ReleaseRecord;
    snapshot: ReturnType<typeof readRelease>['snapshot'];
    pointerReleaseId: string | null;
    legacyLiveBaseline: boolean;
}

interface VerifiedPublicationArtifact extends PublicationRecoverySnapshot {
    snapshotDigest: string;
}

function needsArtifactVerification(release: ReleaseRecord, pointer: ReturnType<typeof readLivePointer>): boolean {
    return release.status === 'publishing'
        || release.status === 'deploying' || release.status === 'verifying'
        || (pointer?.releaseId === release.id && release.status !== 'live');
}

function verifySealedArtifactSnapshot(root: string, work: PublicationRecoverySnapshot): Promise<VerifiedPublicationArtifact | null> {
    return (async () => {
        try {
            const releaseRoot = path.join(root, 'workflow', 'releases', work.releaseId);
            const publicArtifactRoot = path.join(releaseRoot, 'public-artifact');
            const legacyArtifactRoot = releaseRoot;
            const artifactRoot = fs.existsSync(publicArtifactRoot)
                ? publicArtifactRoot
                : fs.existsSync(path.join(legacyArtifactRoot, 'artifacts.json')) || fs.existsSync(path.join(legacyArtifactRoot, 'app'))
                    ? legacyArtifactRoot
                    : null;
            if (!artifactRoot) return null;
            const sealed = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'artifacts.json'), 'utf8')) as unknown;
            const actual = await artifactManifestFactory(artifactRoot, work.releaseId, new Set(['artifacts.json']), work.release.candidateDigest);
            if (stableJsonStringify(actual) !== stableJsonStringify(sealed)
                || actual.releaseId !== work.release.id
                || actual.candidateDigest !== work.release.candidateDigest
                || actual.artifactDigest !== work.release.artifactDigest) return null;
            return { ...work, snapshotDigest: sha256Hex(stableJsonStringify(work.snapshot)) };
        } catch {
            return null;
        }
    })();
}

function collectPublicationRecoverySnapshotsUnderLock(root: string): PublicationRecoverySnapshot[] {
    const releasesRoot = path.join(root, 'workflow', 'releases');
    if (!fs.existsSync(releasesRoot)) return [];
    const pointer = readLivePointer();
    const snapshots: PublicationRecoverySnapshot[] = [];

    for (const releaseId of fs.readdirSync(releasesRoot)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(releaseId)) continue;
        try {
            const stored = readRelease(releaseId);
            const legacyLiveBaseline = stored.release.status === 'live'
                && stored.release.baseLiveReleaseId === (pointer?.releaseId ?? null)
                && stored.release.id !== pointer?.releaseId;
            if (!hasValidReleaseDigests(stored.release, stored.snapshot)
                || (!needsArtifactVerification(stored.release, pointer) && !legacyLiveBaseline)) continue;
            snapshots.push({
                releaseId,
                release: structuredClone(stored.release),
                snapshot: structuredClone(stored.snapshot),
                pointerReleaseId: pointer?.releaseId ?? null,
                legacyLiveBaseline,
            });
        } catch {
            continue;
        }
    }
    return snapshots;
}

function sameRecoveryRelease(current: ReleaseRecord, expected: ReleaseRecord, currentSnapshot: unknown, expectedSnapshotDigest: string): boolean {
    return current.id === expected.id
        && current.status === expected.status
        && current.candidateDigest === expected.candidateDigest
        && current.artifactDigest === expected.artifactDigest
        && current.retryFromAttempt === expected.retryFromAttempt
        && current.publicCommitSha === expected.publicCommitSha
        && current.workflowRunId === expected.workflowRunId
        && current.workflowRunAttempt === expected.workflowRunAttempt
        && current.baseLiveReleaseId === expected.baseLiveReleaseId
        && computeCandidateDigest(currentSnapshot as Parameters<typeof computeCandidateDigest>[0]) === expected.candidateDigest
        && sha256Hex(stableJsonStringify(currentSnapshot)) === expectedSnapshotDigest;
}

function hasPublishJobForIdentity(jobs: JobRecord[], input: Record<string, unknown>): boolean {
    return jobs.some((job) => {
        if (job.type !== 'publish' || !['pending', 'retry', 'running'].includes(job.status)) return false;
        if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return false;
        const current = job.input as Record<string, unknown>;
        return current.releaseId === input.releaseId
            && current.candidateDigest === input.candidateDigest
            && current.artifactDigest === input.artifactDigest
            && current.retry === input.retry
            && current.retryFromAttempt === input.retryFromAttempt;
    });
}

function recoverMissingPublicationJobsUnderLock(
    root: string,
    jobs: JobRecord[],
    verifiedArtifacts: Map<string, VerifiedPublicationArtifact>,
): void {
    const releasesRoot = path.join(root, 'workflow', 'releases');
    if (!fs.existsSync(releasesRoot)) return;
    const pointer = readLivePointer();

    for (const releaseId of fs.readdirSync(releasesRoot)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(releaseId)) continue;
        let stored: ReturnType<typeof readRelease>;
        try {
            stored = readRelease(releaseId);
        } catch {
            continue;
        }
        const { release, snapshot } = stored;
        if (!hasValidReleaseDigests(release, snapshot)) continue;

        const identity = { releaseId, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest };
        const retryFromAttempt = release.retryFromAttempt;
        const authorizedRetry = retryFromAttempt !== null
            && (release.status === 'deploying' || release.status === 'verifying');
        const shouldPublish = release.status === 'publishing' || authorizedRetry;
        const verified = verifiedArtifacts.get(releaseId);
        const currentArtifactVerified = Boolean(verified
            && sameRecoveryRelease(release, verified.release, snapshot, verified.snapshotDigest));
        if (shouldPublish && currentArtifactVerified) {
            const publishInput = authorizedRetry
                ? { ...identity, retry: true, retryFromAttempt }
                : identity;
            if (!hasPublishJobForIdentity(jobs, publishInput)) {
                const job = createOrReuseActiveJobUnderLock(root, {
                    type: 'publish',
                    id: `${authorizedRetry ? `publish-${releaseId}-retry-${retryFromAttempt}` : `publish-${releaseId}`}-recovery-${randomUUID()}`,
                    input: publishInput,
                });
                jobs.push(job);
            }
        }
        const isCurrentPointerRelease = pointer?.releaseId === releaseId
            && pointer.candidateDigest === release.candidateDigest
            && pointer.artifactDigest === release.artifactDigest;

        const pointerBackup = isCurrentPointerRelease ? jobs.find((job) => {
            if (job.type !== 'backup' || !job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return false;
            const input = job.input as Record<string, unknown>;
            if (!input.pointer || typeof input.pointer !== 'object' || Array.isArray(input.pointer)) return false;
            const backupPointer = input.pointer as Record<string, unknown>;
            return backupPointer.releaseId === pointer.releaseId
                && backupPointer.candidateDigest === pointer.candidateDigest
                && backupPointer.artifactDigest === pointer.artifactDigest
                && backupPointer.publicCommitSha === pointer.publicCommitSha
                && backupPointer.workflowRunId === pointer.workflowRunId
                && backupPointer.workflowRunAttempt === pointer.workflowRunAttempt
                && input.reason === 'live-pointer'
                && input.snapshotId === `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`
                && (job.status === 'succeeded' || job.status === 'pending' || job.status === 'retry' || job.status === 'running');
        }) : undefined;
        const hasMatchingPointerBackup = (job: JobRecord): boolean => {
            if (job.type !== 'backup' || !job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return false;
            const input = job.input as Record<string, unknown>;
            if (!input.pointer || typeof input.pointer !== 'object' || Array.isArray(input.pointer)) return false;
            const backupPointer = input.pointer as Record<string, unknown>;
            return backupPointer.releaseId === pointer?.releaseId
                && backupPointer.candidateDigest === pointer?.candidateDigest
                && backupPointer.artifactDigest === pointer?.artifactDigest
                && backupPointer.publicCommitSha === pointer?.publicCommitSha
                && backupPointer.workflowRunId === pointer?.workflowRunId
                && backupPointer.workflowRunAttempt === pointer?.workflowRunAttempt
                && input.reason === 'live-pointer'
                && input.snapshotId === `pointer-${pointer?.releaseId}-${pointer?.workflowRunAttempt}`;
        };
        const pointerBackupExists = Boolean(pointerBackup);
        const pointerBackupTerminalFailure = jobs.some((job) => hasMatchingPointerBackup(job) && job.status === 'failed');
        const shouldRestorePointerBackup = isCurrentPointerRelease
            && !pointerBackupExists && !pointerBackupTerminalFailure;
        if (shouldRestorePointerBackup) {
            const job = createOrReuseActiveJobUnderLock(root, {
                type: 'backup',
                id: `pointer-backup-${pointer.releaseId}-${pointer.workflowRunAttempt}`,
                input: {
                    reason: 'live-pointer',
                    snapshotId: `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`,
                    pointer,
                },
            });
            jobs.push(job);
        }
        const legacyLiveBaseline = verified?.legacyLiveBaseline === true
            && release.status === 'live'
            && release.baseLiveReleaseId === verified.pointerReleaseId
            && release.id !== verified.pointerReleaseId;
        const shouldReconcile = currentArtifactVerified && (((release.status === 'deploying' || release.status === 'verifying')
            && typeof release.publicCommitSha === 'string' && HEX_SHA1.test(release.publicCommitSha))
            || (isCurrentPointerRelease && release.status !== 'live')
            || shouldRestorePointerBackup
            || legacyLiveBaseline);
        if (shouldReconcile && !hasActiveReleaseJob(jobs, 'reconcile', identity)) {
            const job = createOrReuseActiveJobUnderLock(root, {
                type: 'reconcile',
                id: `reconcile-${releaseId}`,
                input: identity,
            });
            jobs.push(job);
        }
    }
}

function recoverMissingCandidateBuildJobsUnderLock(root: string, jobs: JobRecord[]): void {
    const releasesRoot = path.join(root, 'workflow', 'releases');
    if (!fs.existsSync(releasesRoot)) return;

    for (const releaseId of fs.readdirSync(releasesRoot)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(releaseId)) continue;
        let stored: ReturnType<typeof readRelease>;
        try {
            stored = readRelease(releaseId);
        } catch {
            continue;
        }
        if (!CANDIDATE_BUILD_STATUSES.has(stored.release.status)
            || !hasPersistedCandidateProof(root, stored.release)
            || computeCandidateDigest(stored.snapshot) !== stored.release.candidateDigest) {
            continue;
        }

        const hasActiveBuild = jobs.some((job) => {
            if (job.type !== 'build' || !['pending', 'retry', 'running'].includes(job.status)) return false;
            if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) return false;
            const input = job.input as Record<string, unknown>;
            return input.releaseId === releaseId && input.candidateDigest === stored.release.candidateDigest;
        });
        if (hasActiveBuild) continue;

        const job = createOrReuseActiveJobUnderLock(root, {
            type: 'build',
            id: `build-${releaseId}`,
            input: { releaseId, candidateDigest: stored.release.candidateDigest },
        });
        jobs.push(job);
    }
}

export async function listJobs(): Promise<JobRecord[]> {
    return withRuntimeDataRootLock(() => listJobsUnderLock(getRuntimeDataRootPath()));
}

export interface ClaimOptions {
    now?: Date;
    leaseMs?: number;
    types?: readonly JobType[];
}

export function claimNextJobUnderLock(root: string, options: ClaimOptions = {}): JobRecord | null {
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    const allowedTypes = options.types ? new Set(options.types) : null;
    const candidates = listJobsUnderLock(root).filter((job) =>
        (!allowedTypes || allowedTypes.has(job.type)) &&
        (job.status === 'pending' || job.status === 'retry') &&
        job.attempt < MAX_JOB_ATTEMPTS &&
        Date.parse(job.nextAttemptAt) <= nowMs
    );
    const job = candidates[0];
    if (!job) {
        return null;
    }

    const claimed: JobRecord = {
        ...job,
        status: 'running',
        attempt: job.attempt + 1,
        claimedAt: now.toISOString(),
        claimToken: randomUUID(),
        nextAttemptAt: new Date(nowMs + leaseMs).toISOString(),
        updatedAt: now.toISOString(),
    };
    writeJsonAtomically(jobFilePath(root, job.id), claimed);
    return claimed;
}

export async function claimNextJob(options: ClaimOptions = {}): Promise<JobRecord | null> {
    return withRuntimeDataRootLock(() =>
        claimNextJobUnderLock(getRuntimeDataRootPath(), options)
    );
}

function writeClaimResult(
    root: string,
    jobId: string,
    claimToken: string | undefined,
    update: (job: JobRecord, now: Date) => JobRecord,
    now = new Date()
): JobRecord {
    const filePath = jobFilePath(root, jobId);
    const job = readJobFile(filePath);
    if (job.status !== 'running' || (claimToken && job.claimToken !== claimToken)) {
        return job;
    }

    const next = update(job, now);
    writeJsonAtomically(filePath, next);
    return next;
}

export async function completeClaimedJob(
    id: string,
    claimToken: string | undefined,
    result: { remoteCommit?: string } = {},
    now = new Date()
): Promise<JobRecord> {
    return withRuntimeDataRootLock(() => writeClaimResult(
        getRuntimeDataRootPath(),
        id,
        claimToken,
        (job, updatedAt) => ({
            ...job,
            status: 'succeeded',
            claimedAt: null,
            claimToken: undefined,
            remoteCommit: result.remoteCommit ?? job.remoteCommit,
            lastError: null,
            updatedAt: updatedAt.toISOString(),
        }),
        now
    ));
}

export function retryDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.min(exponent, 30)));
}

export async function deferClaimedJob(
    id: string,
    message: string,
    options: { claimToken?: string; now?: Date } = {}
): Promise<JobRecord> {
    const now = options.now ?? new Date();
    return withRuntimeDataRootLock(() => writeClaimResult(
        getRuntimeDataRootPath(),
        id,
        options.claimToken,
        (job, updatedAt) => ({
            ...job,
            status: 'retry',
            attempt: 0,
            claimedAt: null,
            claimToken: undefined,
            nextAttemptAt: new Date(updatedAt.getTime() + retryDelayMs(job.attempt)).toISOString(),
            lastError: message.slice(0, 500),
            updatedAt: updatedAt.toISOString(),
        }),
        now
    ));
}

export async function blockClaimedJob(
    id: string,
    message: string,
    options: { claimToken?: string; now?: Date } = {}
): Promise<JobRecord> {
    const now = options.now ?? new Date();
    return withRuntimeDataRootLock(() => writeClaimResult(
        getRuntimeDataRootPath(),
        id,
        options.claimToken,
        (job, updatedAt) => ({
            ...job,
            status: 'failed',
            claimedAt: null,
            claimToken: undefined,
            nextAttemptAt: updatedAt.toISOString(),
            lastError: message,
            updatedAt: updatedAt.toISOString(),
        }),
        now
    ));
}

export async function failClaimedJob(
    id: string,
    error: unknown,
    options: { claimToken?: string; now?: Date } = {}
): Promise<JobRecord> {
    const now = options.now ?? new Date();
    const message = error instanceof Error ? error.message : String(error);
    return withRuntimeDataRootLock(() => writeClaimResult(
        getRuntimeDataRootPath(),
        id,
        options.claimToken,
        (job, updatedAt) => {
            const canRetry = job.attempt < MAX_JOB_ATTEMPTS;
            return {
                ...job,
                status: canRetry ? 'retry' : 'failed',
                claimedAt: null,
                claimToken: undefined,
                nextAttemptAt: canRetry
                    ? new Date(updatedAt.getTime() + retryDelayMs(job.attempt)).toISOString()
                    : updatedAt.toISOString(),
                lastError: message,
                updatedAt: updatedAt.toISOString(),
            };
        },
        now
    ));
}

export async function heartbeatClaimedJob(
    id: string,
    claimToken: string,
    options: ClaimOptions = {}
): Promise<JobRecord> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    return withRuntimeDataRootLock(() => writeClaimResult(
        getRuntimeDataRootPath(),
        id,
        claimToken,
        (job, updatedAt) => ({
            ...job,
            claimedAt: updatedAt.toISOString(),
            nextAttemptAt: new Date(updatedAt.getTime() + leaseMs).toISOString(),
            updatedAt: updatedAt.toISOString(),
        }),
        now
    ));
}

export async function recoverPersistedJobs(options: ClaimOptions = {}): Promise<JobRecord[]> {
    const now = options.now ?? new Date();
    const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    const root = getRuntimeDataRootPath();
    const { ensureDirtyBackupJobUnderLock } = await import('@/lib/jobs/watermark');
    const phaseOne = await withRuntimeDataRootLock(() => {
        const recovered: JobRecord[] = [];
        for (const job of listJobsUnderLock(root)) {
            const expired = job.status === 'running' && Date.parse(job.nextAttemptAt) <= now.getTime();
            const maxAttemptsExpired = expired && job.attempt >= MAX_JOB_ATTEMPTS;
            if (!expired) {
                recovered.push(job);
                continue;
            }

            const next: JobRecord = {
                ...job,
                status: maxAttemptsExpired ? 'failed' : 'retry',
                claimedAt: null,
                claimToken: undefined,
                nextAttemptAt: maxAttemptsExpired
                    ? now.toISOString()
                    : new Date(now.getTime() + Math.min(leaseMs, retryDelayMs(job.attempt))).toISOString(),
                lastError: job.lastError ?? 'Worker lease expired before completion.',
                updatedAt: now.toISOString(),
            };
            writeJsonAtomically(jobFilePath(root, job.id), next);
            recovered.push(next);
        }

        recoverMissingCandidateBuildJobsUnderLock(root, recovered);
        ensureDirtyBackupJobUnderLock(root);
        const worklist = collectPublicationRecoverySnapshotsUnderLock(root);
        return { recovered, worklist };
    });

    const verifiedArtifacts = new Map<string, VerifiedPublicationArtifact>();
    await Promise.all(phaseOne.worklist.map(async (work) => {
        const verified = await verifySealedArtifactSnapshot(root, work);
        if (verified) verifiedArtifacts.set(work.releaseId, verified);
    }));

    return withRuntimeDataRootLock(() => {
        const recovered = listJobsUnderLock(root);
        ensureDirtyBackupJobUnderLock(root);
        recoverMissingPublicationJobsUnderLock(root, recovered, verifiedArtifacts);
        return recovered;
    });
}
