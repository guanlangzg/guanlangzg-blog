import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuildJobHandler, enqueueCandidateBuild } from '@/lib/editor-runtime/build-runtime';
import { createEditorPublishingService, releaseArtifactsRoot } from '@/lib/editor-runtime/adapters';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { persistVerifiedGitHubBackupProof } from '@/lib/github/backup-service';
import { fromReleaseSnapshot } from '@/lib/public-build/from-release';
import { sha256Hex, stableJsonStringify } from '@/lib/stable-json';
import { listJobs } from '@/lib/jobs/store';
import { readRelease } from '@/lib/publishing/store';

const roots: string[] = [];
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-publishing-runtime-'));
  roots.push(root);
  vi.stubEnv('BLOG_DATA_ROOT', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function previewReady() {
  const service = createEditorPublishingService();
  const created = await service.createCandidate({ kind: 'bootstrap', articleIds: [] });
  const artifactDigest = 'a'.repeat(64);
  const backupProof = {
    repository: 'test-owner/private-backup', commitSha: 'b'.repeat(40), snapshotId: `candidate-${created.release.id}`,
    contentDigest: 'c'.repeat(64), candidateDigest: created.release.candidateDigest, verifiedAt: '2026-10-01T00:00:00.000Z',
  };
  const root = process.env.BLOG_DATA_ROOT!;
  fs.mkdirSync(path.join(root, 'workflow', 'backup-proofs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'backup-proofs', `${backupProof.snapshotId}.json`), JSON.stringify(backupProof));
  const artifactsRoot = releaseArtifactsRoot(created.release.id);
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactsRoot, 'artifacts.json'), JSON.stringify({
    version: 1, releaseId: created.release.id, candidateDigest: created.release.candidateDigest, artifactDigest,
  }));
  await service.markPreviewReady(created.release.id, { artifactDigest, backupProof });
  return { service, release: created.release, payload: { candidateDigest: created.release.candidateDigest, artifactDigest } };
}

describe('production publishing task persistence', () => {
  it('passes the frozen candidate identity through the persistent proof and real build handler', async () => {
    vi.stubEnv('BLOG_BUILD_ROOT', path.join(process.env.BLOG_DATA_ROOT!, 'build'));
    const dataRoot = process.env.BLOG_DATA_ROOT!;
    fs.mkdirSync(path.join(dataRoot, 'articles'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'articles', 'articles.json'), JSON.stringify([{
      id: 'build-article', slug: 'build-article', title: 'Build article', date: '2026-10-01',
      description: 'Handler integration fixture', tags: ['test'], content: '# Build article', createdAt: 1, updatedAt: 1,
    }]));
    const service = createEditorPublishingService();
    const created = await service.createCandidate({ kind: 'article', articleId: 'build-article', action: 'publish' });
    const backupProof = {
      repository: 'test-owner/private-backup', commitSha: 'b'.repeat(40), snapshotId: `candidate-${created.release.id}`,
      contentDigest: 'c'.repeat(64), candidateDigest: created.release.candidateDigest, verifiedAt: '2026-10-01T00:00:00.000Z',
    };
    await persistVerifiedGitHubBackupProof(backupProof, created.release.id);
    const buildJob = (await listJobs()).find((job) => job.type === 'build');
    expect(buildJob).toBeDefined();

    await createBuildJobHandler()(buildJob!);

    const ready = readRelease(created.release.id);
    const artifactRoot = releaseArtifactsRoot(created.release.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'artifacts.json'), 'utf8')) as {
      candidateDigest: string;
    };
    const marker = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'app', 'out', '_release.json'), 'utf8')) as {
      releaseId: string;
      candidateDigest: string;
      snapshotDigest: string;
    };
    const projected = fromReleaseSnapshot(created.release.id, ready.snapshot);
    const publicCandidateDigest = sha256Hex(stableJsonStringify(projected));
    const frozenSnapshotDigest = sha256Hex(JSON.stringify(projected));
    expect(ready.release.status).toBe('preview_ready');
    expect(manifest.candidateDigest).toBe(computeCandidateDigest(ready.snapshot));
    expect(publicCandidateDigest).not.toBe(manifest.candidateDigest);
    expect(manifest.candidateDigest).toBe(created.release.candidateDigest);
    // Both digests the child verified against the frozen bytes are sealed into the artifact.
    expect(marker).toMatchObject({
      releaseId: created.release.id,
      candidateDigest: created.release.candidateDigest,
      snapshotDigest: frozenSnapshotDigest,
    });
  }, 600_000);

  it('rejects a build job whose digest is not the digest of the frozen release', async () => {
    const dataRoot = process.env.BLOG_DATA_ROOT!;
    fs.mkdirSync(path.join(dataRoot, 'articles'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'articles', 'articles.json'), JSON.stringify([{
      id: 'rejected-article', slug: 'rejected-article', title: 'Rejected article', date: '2026-10-01',
      description: 'Digest rejection fixture', tags: ['test'], content: '# Rejected', createdAt: 1, updatedAt: 1,
    }]));
    const created = await createEditorPublishingService().createCandidate({ kind: 'article', articleId: 'rejected-article', action: 'publish' });
    const job = await enqueueCandidateBuild(created.release.id, 'f'.repeat(64));
    const statusBefore = readRelease(created.release.id).release.status;

    await expect(createBuildJobHandler()(job)).rejects.toThrow(/frozen release/i);
    expect(readRelease(created.release.id).release.status).toBe(statusBefore);
    expect(fs.existsSync(releaseArtifactsRoot(created.release.id))).toBe(false);
  });

  it('persists authorization and the sealed artifact identity with the real publish job', async () => {
    const test = await previewReady();
    const task = await test.service.confirm(test.release.id, test.payload);

    expect(readRelease(test.release.id).release.status).toBe('publishing');
    expect((await listJobs()).find((job) => job.id === task.id)).toMatchObject({
      type: 'publish', status: 'pending', input: { releaseId: test.release.id, ...test.payload },
    });
    expect(fs.existsSync(path.join(process.env.BLOG_DATA_ROOT!, 'workflow', 'publish-tasks'))).toBe(false);
  });

  it('ignores historical sidecar success and returns only the current job state', async () => {
    const test = await previewReady();
    const legacyRoot = path.join(process.env.BLOG_DATA_ROOT!, 'workflow', 'publish-tasks');
    fs.mkdirSync(legacyRoot, { recursive: true });
    const legacy = JSON.stringify({ id: 'legacy-publish', type: 'publish', status: 'succeeded', input: { releaseId: test.release.id } });
    fs.writeFileSync(path.join(legacyRoot, 'legacy.json'), legacy);

    const task = await test.service.confirm(test.release.id, test.payload);
    const duplicate = await createEditorPublishingService().confirm(test.release.id, test.payload);

    expect(task.status).toBe('pending');
    expect(duplicate).toEqual(task);
    expect(task.id).not.toBe('legacy-publish');
    expect(fs.readFileSync(path.join(legacyRoot, 'legacy.json'), 'utf8')).toBe(legacy);
    expect((await listJobs()).filter((job) => job.type === 'publish')).toHaveLength(1);
  });

  it('rejects a mismatched confirmation digest even when an authorized job already exists', async () => {
    const test = await previewReady();
    await test.service.confirm(test.release.id, test.payload);

    await expect(test.service.confirm(test.release.id, { ...test.payload, artifactDigest: 'd'.repeat(64) }))
      .rejects.toMatchObject({ status: 409, code: 'ARTIFACT_MISMATCH' });
    expect((await listJobs()).filter((job) => job.type === 'publish')).toHaveLength(1);
  });
});
