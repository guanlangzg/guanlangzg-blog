import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorPublishingService, releaseArtifactsRoot } from '@/lib/editor-runtime/adapters';
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
