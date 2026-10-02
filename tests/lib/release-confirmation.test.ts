import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { createPublishingService, type PublishingTransaction } from '@/lib/publishing/service';
import type { LivePointer, PublishScope, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scope: PublishScope = { kind: 'article', articleId: 'a', action: 'publish' };
const article = (id: string, content: string) => ({
  id, slug: id, title: id, date: '2026-09-30', description: '', tags: [], content,
  createdAt: 1, updatedAt: 2, status: 'published' as const,
});
const snapshot = (articles: SiteSnapshot['articles'] = []): SiteSnapshot => ({
  schemaVersion: 1, siteId: 'site', articles, navigation: [], settings: { ...DEFAULT_SITE_SETTINGS },
  media: [], redirects: [], removedPaths: [],
});
const proof = (candidateDigest: string) => ({
  repository: 'owner/private-backup', commitSha: 'a'.repeat(40), snapshotId: 'backup-1',
  contentDigest: 'b'.repeat(64), candidateDigest, verifiedAt: '2026-09-30T00:00:00.000Z',
});

class MemoryTransaction implements PublishingTransaction {
  inputs = { baseSnapshot: snapshot([article('b', 'B live')]), draftSnapshot: snapshot([article('a', 'A frozen'), article('b', 'B latest draft')]), generation: 'g1', selectedInputs: { id: 'a', revision: 'r1' }, revision: 'r1' };
  live: LivePointer | null = null;
  watermark = { generation: 'g1', contentSequence: 2, backedUpThrough: 2, blockedReason: null as string | null };
  releases = new Map<string, { release: ReleaseRecord; snapshot: SiteSnapshot }>();
  tasks = new Map<string, { id: string; releaseId: string; status: 'pending' }>();
  readInputs(_scope: PublishScope) { return structuredClone(this.inputs); }
  readLivePointer() { return this.live; }
  listReleases() { return [...this.releases.values()].map(({ release }) => structuredClone(release)); }
  readRelease(id: string) { const found = this.releases.get(id); if (!found) throw new Error('missing release'); return structuredClone(found); }
  readWatermark() { return { ...this.watermark }; }
  writeRelease(release: ReleaseRecord, value: SiteSnapshot) { this.releases.set(release.id, { release: structuredClone(release), snapshot: structuredClone(value) }); }
  persistCandidateJobs(_release: ReleaseRecord, _value: SiteSnapshot) {}
  persistPublishTask(release: ReleaseRecord, value: SiteSnapshot) {
    this.writeRelease(release, value);
    const task = { id: `task-${release.id}`, releaseId: release.id, status: 'pending' as const };
    this.tasks.set(release.id, task);
    return task;
  }
  findPublishTask(id: string) { return this.tasks.get(id) ?? null; }
}

let tx: MemoryTransaction;
let id = 0;
let service: ReturnType<typeof createPublishingService>;

function setup() {
  tx = new MemoryTransaction();
  id = 0;
  service = createPublishingService({
    withContentLock: async (operation) => operation(tx),
    createId: () => `release-${++id}`,
    now: () => '2026-09-30T00:00:00.000Z',
    verifyMediaHashes: () => true,
    verifyArtifactIdentity: (release) => ({
      releaseId: release.id, candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest ?? '',
    }),
    isBackupProofValid: (candidateProof, release) => candidateProof?.candidateDigest === release.candidateDigest,
  });
}

async function previewReady() {
  const created = await service.createCandidate(scope);
  const artifactDigest = digest('artifact');
  const sealedSnapshot = { ...created.snapshot, releaseId: created.release.id };
  const candidateDigest = computeCandidateDigest(created.snapshot);
  await service.markPreviewReady(created.release.id, { artifactDigest, backupProof: proof(candidateDigest) });
  return { release: { ...created.release, candidateDigest, artifactDigest }, snapshot: sealedSnapshot };
}

function confirmPayload(candidate: { release: ReleaseRecord }) {
  return { candidateDigest: candidate.release.candidateDigest, artifactDigest: candidate.release.artifactDigest as string };
}

describe('publishing confirmation contracts', () => {
  it('rejects a candidate request whose expected resource revision is stale', async () => {
    setup();
    await expect(service.createCandidate(scope, 'r2')).rejects.toMatchObject({ status: 409 });
    expect(tx.releases.size).toBe(0);
  });

  it('confirms a frozen A snapshot without changing live B or including B draft text', async () => {
    setup();
    const candidate = await previewReady();
    const frozen = tx.readRelease(candidate.release.id).snapshot;
    tx.inputs.draftSnapshot.articles[1].content = 'B changed after candidate creation';

    const task = await service.confirm(candidate.release.id, confirmPayload(candidate));

    expect(frozen.articles.map((item) => item.content).sort()).toEqual(['A frozen', 'B live'].sort());
    expect(JSON.stringify(frozen)).not.toContain('B latest draft');
    expect(task.releaseId).toBe(candidate.release.id);
    expect(tx.readLivePointer()).toBeNull();
  });

  it('blocks on the global backup watermark without staling the preview, then confirms the same artifact', async () => {
    setup();
    const candidate = await previewReady();
    tx.watermark.backedUpThrough = 1;

    await expect(service.confirm(candidate.release.id, confirmPayload(candidate))).rejects.toMatchObject({ status: 503 });
    expect(tx.readRelease(candidate.release.id).release.status).toBe('preview_ready');
    tx.watermark.backedUpThrough = tx.watermark.contentSequence;
    await expect(service.confirm(candidate.release.id, confirmPayload(candidate))).resolves.toMatchObject({ releaseId: candidate.release.id });
  });

  it('requires a valid candidate proof and the sealed artifact digest', async () => {
    setup();
    const candidate = await previewReady();
    tx.writeRelease({
      ...tx.readRelease(candidate.release.id).release,
      status: 'building',
      backupProof: null,
    }, candidate.snapshot);
    await service.markPreviewReady(candidate.release.id, { artifactDigest: candidate.release.artifactDigest as string, backupProof: null });
    await expect(service.confirm(candidate.release.id, confirmPayload(candidate))).rejects.toMatchObject({ status: 503 });
    tx.writeRelease({ ...tx.readRelease(candidate.release.id).release, status: 'building' }, candidate.snapshot);
    await service.markPreviewReady(candidate.release.id, { artifactDigest: candidate.release.artifactDigest as string, backupProof: proof(candidate.release.candidateDigest) });
    await expect(service.confirm(candidate.release.id, { ...confirmPayload(candidate), artifactDigest: digest('tampered') })).rejects.toMatchObject({ status: 409 });
  });

  it('allows a retryable public build failure to become preview-ready again', async () => {
    setup();
    const candidate = await previewReady();
    tx.writeRelease({ ...tx.readRelease(candidate.release.id).release, status: 'building' }, candidate.snapshot);
    const failed = await service.markPreviewFailed(candidate.release.id, 'compiler output');

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'PUBLIC_BUILD_FAILED', retryable: true });

    const recovered = await service.markPreviewReady(candidate.release.id, {
      artifactDigest: candidate.release.artifactDigest as string,
      backupProof: candidate.release.backupProof,
    });

    expect(recovered.status).toBe('preview_ready');
    expect(recovered.error).toBeNull();
  });

  it('returns a conflict when another release already owns the publish slot', async () => {
    setup();
    const first = await previewReady();
    const second = await previewReady();
    await service.confirm(first.release.id, confirmPayload(first));

    await expect(service.confirm(second.release.id, confirmPayload(second))).rejects.toMatchObject({ status: 409 });
    expect(tx.readRelease(second.release.id).release.status).toBe('preview_ready');
  });

  it('marks a candidate stale when its selected input revision changes', async () => {
    setup();
    const candidate = await previewReady();
    tx.inputs.selectedInputs = { id: 'a', revision: 'r2' };

    await expect(service.confirm(candidate.release.id, confirmPayload(candidate))).rejects.toMatchObject({ status: 409 });
    expect(tx.readRelease(candidate.release.id).release.status).toBe('stale');
  });

  it('marks a candidate stale when the live baseline changes', async () => {
    setup();
    const candidate = await previewReady();
    const liveRelease = { ...tx.readRelease(candidate.release.id).release, id: 'release-live', status: 'live' as const };
    tx.writeRelease(liveRelease, snapshot([article('b', 'B now live')]));
    tx.live = {
      schemaVersion: 1, releaseId: liveRelease.id, candidateDigest: liveRelease.candidateDigest,
      artifactDigest: digest('live'), publicCommitSha: 'c'.repeat(40), workflowRunId: 12,
      workflowRunAttempt: 1, verifiedAt: '2026-09-30T00:00:00.000Z',
    };

    await expect(service.confirm(candidate.release.id, confirmPayload(candidate))).rejects.toMatchObject({ status: 409 });
    expect(tx.readRelease(candidate.release.id).release.status).toBe('stale');
  });
});
