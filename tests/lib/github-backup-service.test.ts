import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeArticlesToDisk, writeNavigationToDisk, writeSiteSettingsToDisk } from '@/lib/editor-data-storage';
import { storeEditorMediaFile, writeEditorMediaManifest } from '@/lib/editor-media-storage';
import { createCurrentGitHubBackupSnapshotInput, createGitHubBackupJobHandler, enqueueCurrentGitHubBackup, persistVerifiedGitHubBackupProof } from '@/lib/github/backup-service';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { listJobs, type JobRecord } from '@/lib/jobs/store';
import type { GitHubRestClient } from '@/lib/github/client';
import type { BackupSnapshotInput, BackupWriteOptions } from '@/lib/github/backup';
import type { BackupProof, LivePointer, SiteSnapshot } from '@/lib/publishing/types';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { readBackupWatermark } from '@/lib/jobs/watermark';
import { readRelease, writeLivePointer, writeRelease } from '@/lib/publishing/store';

const { writeGitHubBackupMock } = vi.hoisted(() => ({ writeGitHubBackupMock: vi.fn() }));

vi.mock('@/lib/github/backup', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github/backup')>(),
  writeGitHubBackup: writeGitHubBackupMock,
}));

writeGitHubBackupMock.mockImplementation(async (
  _client: GitHubRestClient,
  input: BackupSnapshotInput,
  options: BackupWriteOptions = {},
) => {
  const proof: BackupProof = {
    repository: 'owner/private-backup',
    commitSha: 'f'.repeat(40),
    snapshotId: input.snapshotId,
    contentDigest: 'e'.repeat(64),
    candidateDigest: input.publication.candidate?.candidateDigest || 'e'.repeat(64),
    verifiedAt: '2026-09-30T04:00:00.000Z',
  };
  await options.persistProof?.(proof);
  return proof;
});

const originalDataRoot = process.env.BLOG_DATA_ROOT;
let dataRoot = '';

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-github-backup-service-'));
  process.env.BLOG_DATA_ROOT = dataRoot;
});

afterEach(() => {
  if (originalDataRoot === undefined) delete process.env.BLOG_DATA_ROOT;
  else process.env.BLOG_DATA_ROOT = originalDataRoot;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('GitHub backup snapshot capture', () => {
  it('captures editor data and reuses a persisted stable site ID', async () => {
    const article = {
      id: 'captured-article',
      slug: 'captured-article',
      title: 'Captured article',
      date: '2026-09-30',
      description: '',
      tags: [],
      content: 'body\r\n',
      createdAt: 1,
      updatedAt: 2,
      status: 'draft' as const,
    };
    await writeArticlesToDisk([article]);
    await writeNavigationToDisk([]);
    await writeSiteSettingsToDisk({ ...DEFAULT_SITE_SETTINGS });

    const first = await createCurrentGitHubBackupSnapshotInput({ snapshotId: 'snapshot-1' });
    const second = await createCurrentGitHubBackupSnapshotInput({ snapshotId: 'snapshot-2' });

    expect(first.articles[0]).toMatchObject(article);
    expect(first.articles[0]?.content).toBe('body\r\n');
    expect(second.siteId).toBe(first.siteId);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'workflow', 'format.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      siteId: first.siteId,
    });
  });

  it('queues a backup with the watermarked generation under the data-root transaction', async () => {
    await writeArticlesToDisk([]);
    const job = await enqueueCurrentGitHubBackup({ reason: 'manual', now: new Date('2026-09-30T04:00:00.000Z') });
    const jobs = await listJobs();

    expect(jobs).toContainEqual(job);
    expect(job.type).toBe('backup');
    expect(job.input).toMatchObject({ reason: 'manual', generation: expect.any(String), contentSequence: 1, snapshotId: expect.any(String) });
  });

  it('does not let a candidate backup claim the global watermark', async () => {
    await writeArticlesToDisk([]);
    const snapshot: SiteSnapshot = {
      schemaVersion: 1,
      siteId: 'site-1',
      articles: [],
      navigation: [],
      settings: { ...DEFAULT_SITE_SETTINGS },
      media: [],
      redirects: [],
      removedPaths: [],
    };
    const release = {
      schemaVersion: 1 as const,
      id: 'release-1',
      scope: { kind: 'bootstrap' as const, articleIds: [] },
      baseLiveReleaseId: null,
      selectedRevision: 'd'.repeat(64),
      candidateDigest: computeCandidateDigest(snapshot),
      artifactDigest: null,
      status: 'building' as const,
      backupProof: null,
      publicCommitSha: null,
      workflowRunId: null,
      workflowRunAttempt: null,
      retryFromAttempt: null,
      error: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    };
    writeRelease(release, snapshot);
    const job: JobRecord = {
      id: 'candidate-job',
      type: 'backup',
      inputDigest: 'digest',
      input: {
        reason: 'candidate-preview',
        generation: (await readBackupWatermark()).generation,
        contentSequence: 1,
        snapshotId: 'candidate-snapshot',
        candidateReleaseId: 'release-1',
      },
      status: 'running',
      attempt: 1,
      nextAttemptAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      remoteCommit: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await createGitHubBackupJobHandler({} as GitHubRestClient)(job);

    expect(result).not.toHaveProperty('verifiedFullBackup', true);
    expect(readRelease('release-1').release.backupProof?.candidateDigest).toBe(release.candidateDigest);
    expect((await readBackupWatermark()).backedUpThrough).toBe(0);
  });

  it('marks a matching full backup job as watermark-eligible', async () => {
    await writeArticlesToDisk([]);
    const watermark = await readBackupWatermark();
    const job: JobRecord = {
      id: 'full-backup-job',
      type: 'backup',
      inputDigest: 'digest',
      input: {
        reason: 'scheduled-full',
        generation: watermark.generation,
        contentSequence: watermark.contentSequence,
        snapshotId: 'full-snapshot',
      },
      status: 'running',
      attempt: 1,
      nextAttemptAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      remoteCommit: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = await createGitHubBackupJobHandler({} as GitHubRestClient)(job);

    expect(result).toEqual({ remoteCommit: 'f'.repeat(40), verifiedFullBackup: true });
  });

  it('captures the exact requested live pointer even when the current live pointer has advanced', async () => {
    await writeArticlesToDisk([]);
    const snapshot: SiteSnapshot = {
      schemaVersion: 1,
      siteId: 'site-1',
      articles: [],
      navigation: [],
      settings: { ...DEFAULT_SITE_SETTINGS },
      media: [],
      redirects: [],
      removedPaths: [],
    };
    const release = {
      schemaVersion: 1 as const,
      id: 'release-live',
      scope: { kind: 'bootstrap' as const, articleIds: [] },
      baseLiveReleaseId: null,
      selectedRevision: 'd'.repeat(64),
      candidateDigest: computeCandidateDigest(snapshot),
      artifactDigest: 'a'.repeat(64),
      status: 'live' as const,
      backupProof: null,
      publicCommitSha: 'b'.repeat(40),
      workflowRunId: 123,
      workflowRunAttempt: 2,
      retryFromAttempt: null,
      error: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    };
    writeRelease(release, snapshot);
    const requestedPointer: LivePointer = {
      schemaVersion: 1,
      releaseId: release.id,
      candidateDigest: release.candidateDigest,
      artifactDigest: release.artifactDigest,
      publicCommitSha: release.publicCommitSha,
      workflowRunId: release.workflowRunId,
      workflowRunAttempt: release.workflowRunAttempt,
      verifiedAt: '2026-09-30T01:00:00.000Z',
    };
    writeLivePointer(requestedPointer);
    const job: JobRecord = {
      id: 'pointer-backup-job',
      type: 'backup',
      inputDigest: 'digest',
      input: { reason: 'live-pointer', snapshotId: 'pointer-snapshot', pointer: requestedPointer },
      status: 'running',
      attempt: 1,
      nextAttemptAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      remoteCommit: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const laterPointer: LivePointer = {
      ...requestedPointer,
      releaseId: 'later-release',
      candidateDigest: 'c'.repeat(64),
      artifactDigest: 'e'.repeat(64),
    };
    writeLivePointer(laterPointer);

    const result = await createGitHubBackupJobHandler({} as GitHubRestClient)(job);

    expect(result).not.toHaveProperty('verifiedFullBackup', true);
    expect(writeGitHubBackupMock.mock.lastCall?.[1].publication.live).toEqual(requestedPointer);
    expect(writeGitHubBackupMock.mock.lastCall?.[1].publication.liveSnapshot).toEqual(snapshot);
    expect(writeGitHubBackupMock.mock.lastCall?.[1].publication.candidate).toBeNull();
    expect(fs.existsSync(path.join(dataRoot, 'workflow', 'backup-proofs', 'pointer-snapshot.json'))).toBe(false);
    expect((await readBackupWatermark()).backedUpThrough).toBe(0);
  });

  it('includes media from the frozen live snapshot when it is absent from the current manifest', async () => {
    await writeArticlesToDisk([]);
    const media = await storeEditorMediaFile({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      now: new Date('2026-09-30T00:00:00.000Z'),
    });
    const snapshot: SiteSnapshot = {
      schemaVersion: 1,
      siteId: 'site-1',
      articles: [],
      navigation: [],
      settings: { ...DEFAULT_SITE_SETTINGS },
      media: [{
        originalPath: media.asset.path,
        publicPath: media.asset.publicPath,
        sha256: media.asset.hash,
        size: media.asset.size,
        mimeType: media.asset.mimeType,
      }],
      redirects: [],
      removedPaths: [],
    };
    const release = {
      schemaVersion: 1 as const,
      id: 'release-media',
      scope: { kind: 'bootstrap' as const, articleIds: [] },
      baseLiveReleaseId: null,
      selectedRevision: 'd'.repeat(64),
      candidateDigest: computeCandidateDigest(snapshot),
      artifactDigest: 'a'.repeat(64),
      status: 'live' as const,
      backupProof: null,
      publicCommitSha: 'b'.repeat(40),
      workflowRunId: 124,
      workflowRunAttempt: 1,
      retryFromAttempt: null,
      error: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    };
    writeRelease(release, snapshot);
    const pointer: LivePointer = {
      schemaVersion: 1,
      releaseId: release.id,
      candidateDigest: release.candidateDigest,
      artifactDigest: release.artifactDigest,
      publicCommitSha: release.publicCommitSha,
      workflowRunId: release.workflowRunId,
      workflowRunAttempt: release.workflowRunAttempt,
      verifiedAt: '2026-09-30T01:00:00.000Z',
    };
    await writeEditorMediaManifest({ version: 1, updatedAt: '2026-09-30T00:00:00.000Z', assets: [] });
    const job: JobRecord = {
      id: 'pointer-media-job', type: 'backup', inputDigest: 'digest',
      input: { reason: 'live-pointer', snapshotId: 'pointer-media-snapshot', pointer },
      status: 'running', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: new Date().toISOString(),
      remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await createGitHubBackupJobHandler({} as GitHubRestClient)(job);

    const captured = writeGitHubBackupMock.mock.lastCall?.[1];
    expect(captured?.mediaManifest.assets).toContainEqual({ ...media.asset, createdAt: release.updatedAt, updatedAt: release.updatedAt });
    const capturedMedia = captured?.mediaObjects.find((item: BackupSnapshotInput['mediaObjects'][number]) => item.assetPath === media.asset.path);
    expect(capturedMedia).toBeDefined();
    expect([...capturedMedia!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  });

  it('rejects a pointer whose frozen candidate digest does not match its release', async () => {
    await writeArticlesToDisk([]);
    const pointer: LivePointer = {
      schemaVersion: 1,
      releaseId: 'missing-release',
      candidateDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      publicCommitSha: 'c'.repeat(40),
      workflowRunId: 1,
      workflowRunAttempt: 1,
      verifiedAt: '2026-09-30T01:00:00.000Z',
    };
    const job: JobRecord = {
      id: 'invalid-pointer-job', type: 'backup', inputDigest: 'digest',
      input: { reason: 'live-pointer', snapshotId: 'invalid-pointer', pointer },
      status: 'running', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: new Date().toISOString(),
      remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await expect(createGitHubBackupJobHandler({} as GitHubRestClient)(job)).rejects.toThrow();
    expect(fs.existsSync(path.join(dataRoot, 'workflow', 'backup-proofs', 'invalid-pointer.json'))).toBe(false);
  });

  it('persists verified proof without exposing or changing its content', async () => {
    const proof: BackupProof = {
      repository: 'owner/private-backup',
      commitSha: 'a'.repeat(40),
      snapshotId: 'proof-snapshot',
      contentDigest: 'b'.repeat(64),
      candidateDigest: 'c'.repeat(64),
      verifiedAt: '2026-09-30T04:00:00.000Z',
    };
    const persistProof = vi.fn();

    await persistVerifiedGitHubBackupProof(proof);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataRoot, 'workflow', 'backup-proofs', 'proof-snapshot.json'), 'utf8'));
    persistProof(persisted);

    expect(persisted).toEqual(proof);
    expect(persistProof).toHaveBeenCalledWith(proof);
  });

  it('registers the candidate build job while persisting its verified proof', async () => {
    await writeArticlesToDisk([]);
    const snapshot: SiteSnapshot = {
      schemaVersion: 1,
      siteId: 'site-1',
      articles: [],
      navigation: [],
      settings: { ...DEFAULT_SITE_SETTINGS },
      media: [],
      redirects: [],
      removedPaths: [],
    };
    const release = {
      schemaVersion: 1 as const,
      id: 'release-1',
      scope: { kind: 'bootstrap' as const, articleIds: [] },
      baseLiveReleaseId: null,
      selectedRevision: 'd'.repeat(64),
      candidateDigest: computeCandidateDigest(snapshot),
      artifactDigest: null,
      status: 'building' as const,
      backupProof: null,
      publicCommitSha: null,
      workflowRunId: null,
      workflowRunAttempt: null,
      retryFromAttempt: null,
      error: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    };
    writeRelease(release, snapshot);
    const proof: BackupProof = {
      repository: 'owner/private-backup',
      commitSha: 'a'.repeat(40),
      snapshotId: 'candidate-proof',
      contentDigest: 'b'.repeat(64),
      candidateDigest: release.candidateDigest,
      verifiedAt: '2026-09-30T04:00:00.000Z',
    };

    await persistVerifiedGitHubBackupProof(proof, release.id);

    expect((await listJobs()).filter((job) => job.type === 'build')).toEqual([
      expect.objectContaining({
        id: 'build-release-1',
        input: { releaseId: 'release-1', candidateDigest: release.candidateDigest },
        status: 'pending',
      }),
    ]);
  });
});
