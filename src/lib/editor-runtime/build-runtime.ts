import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyArtifactTree } from '@/lib/public-build/runner';
import { fromReleaseSnapshot } from '@/lib/public-build/from-release';
import {
  createEditorPublishingService,
  findSealedArtifactRoot,
  readEditorMediaFile,
  releaseArtifactsRoot,
  verifyBackupProof,
} from '@/lib/editor-runtime/adapters';
import { readRelease } from '@/lib/publishing/store';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { createOrReuseActiveJobUnderLock, type JobRecord } from '@/lib/jobs/store';
import { readEditorMediaManifest } from '@/lib/editor-media-storage';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildScript = path.join(projectRoot, 'scripts', 'public-site', 'build.mjs');
const MAX_BUILD_MS = 600_000;
const MAX_BUILD_OUTPUT_BYTES = 32 * 1024 * 1024;

function buildRoot(): string {
  const configured = process.env.BLOG_BUILD_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), 'guanlangzg-blog-build');
}

function validJobInput(job: JobRecord): { releaseId: string; candidateDigest: string } {
  if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) throw new Error('Build job input is invalid.');
  const input = job.input as Record<string, unknown>;
  if (typeof input.releaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.releaseId)
      || typeof input.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(input.candidateDigest)) {
    throw new Error('Build job input is invalid.');
  }
  return { releaseId: input.releaseId, candidateDigest: input.candidateDigest };
}

function execPublicBuild(
  input: { snapshotPath: string; identityPath: string; snapshotDigest: string },
  outputPath: string,
  candidateDigest: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      buildScript,
      '--snapshot', input.snapshotPath,
      '--identity', input.identityPath,
      '--out', outputPath,
      '--candidate-digest', candidateDigest,
      '--snapshot-digest', input.snapshotDigest,
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        BLOG_BUILD_ROOT: buildRoot(),
      },
    });
    let bytes = 0;
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), MAX_BUILD_MS);
    const collect = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BUILD_OUTPUT_BYTES) child.kill('SIGKILL');
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Static build failed (${signal ?? code}): ${output.slice(-2000)}`));
    });
  });
}

/**
 * The public snapshot is a projection of the candidate, so its digest cannot be recomputed
 * from a candidate digest. The identity document written next to the frozen bytes carries
 * both digests into the build child, which re-verifies them against those bytes before it
 * seals anything, and `sealBuildOutput` re-verifies the sealed digest against the release.
 */
async function writeFrozenInput(
  release: ReleaseRecord,
  snapshot: SiteSnapshot,
  candidateDigest: string,
  directory: string,
): Promise<{ snapshotPath: string; identityPath: string; snapshotDigest: string }> {
  const mediaRoot = path.join(directory, 'media');
  await fs.mkdir(mediaRoot, { recursive: true });
  const publicSnapshot = fromReleaseSnapshot(release.id, snapshot);
  for (const media of publicSnapshot.media ?? []) {
    const asset = readEditorMediaManifest().assets.find((item) => `media/${item.path.replaceAll('\\', '/')}` === media.source.replace(/^media[\\/]/, 'media/'));
    if (!asset) throw new Error('Frozen media reference is missing.');
    const frozen = snapshot.media.find((item) => item.originalPath === asset.path);
    if (!frozen) throw new Error('Frozen media identity is missing.');
    const bytes = await readEditorMediaFile(asset);
    if (!bytes || bytes.byteLength !== frozen.size || createHash('sha256').update(bytes).digest('hex') !== frozen.sha256) {
      throw new Error(`Frozen media bytes do not match: ${asset.path}`);
    }
    const target = path.resolve(directory, ...media.source.split('/'));
    const relative = path.relative(directory, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Frozen media path escapes the build staging directory.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  const input = path.join(directory, 'snapshot.json');
  const serialized = JSON.stringify(publicSnapshot);
  const snapshotDigest = createHash('sha256').update(serialized).digest('hex');
  await fs.writeFile(input, serialized, { flag: 'wx' });
  const identityPath = path.join(directory, 'candidate-identity.json');
  await fs.writeFile(identityPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: release.id,
    candidateDigest,
    snapshotDigest,
  }), { flag: 'wx' });
  return { snapshotPath: input, identityPath, snapshotDigest };
}

async function sealBuildOutput(releaseId: string, outputRoot: string, candidateDigest: string): Promise<string> {
  const releaseRoot = releaseArtifactsRoot(releaseId);
  const sourceReleaseRoot = path.join(outputRoot, releaseId);
  const manifestPath = path.join(sourceReleaseRoot, 'artifacts.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { releaseId?: unknown; candidateDigest?: unknown; artifactDigest?: unknown };
  if (manifest.releaseId !== releaseId || manifest.candidateDigest !== candidateDigest || typeof manifest.artifactDigest !== 'string') {
    throw new Error('Built artifact identity does not match its frozen candidate.');
  }
  await verifyArtifactTree(sourceReleaseRoot);

  const existingRoot = findSealedArtifactRoot(releaseId);
  if (existingRoot) {
    const existingManifestPath = path.join(existingRoot, 'artifacts.json');
    if (!await fs.access(existingManifestPath).then(() => true, () => false)) {
      throw new Error('A partial sealed artifact tree exists for this release.');
    }
    const existing = await verifyArtifactTree(existingRoot);
    if (existing.artifactDigest !== manifest.artifactDigest || existing.candidateDigest !== candidateDigest) {
      throw new Error('A different sealed artifact already exists for this release.');
    }
    return manifest.artifactDigest;
  }

  // The persisted release is the authority for the candidate digest: the sealed artifact may
  // only be committed when the release still carries the digest this build was started for.
  const stored = readRelease(releaseId);
  if (stored.release.candidateDigest !== candidateDigest || computeCandidateDigest(stored.snapshot) !== candidateDigest) {
    throw new Error('Candidate changed while its public artifact was building.');
  }

  const releaseParent = path.dirname(releaseRoot);
  await fs.mkdir(releaseParent, { recursive: true });
  const staging = path.join(releaseParent, `.public-artifact-${releaseId}-${process.pid}-${Date.now()}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(sourceReleaseRoot, staging, { recursive: true, errorOnExist: true, force: false });
  try {
    await verifyArtifactTree(staging);
    try {
      await fs.rename(staging, releaseRoot);
    } catch (error) {
      const targetExists = await fs.access(releaseRoot).then(() => true, () => false);
      if (!targetExists) throw error;
      const targetManifestPath = path.join(releaseRoot, 'artifacts.json');
      if (!await fs.access(targetManifestPath).then(() => true, () => false)) {
        throw new Error('A partial sealed artifact tree won the commit race.');
      }
      const existing = await verifyArtifactTree(releaseRoot);
      if (existing.artifactDigest !== manifest.artifactDigest || existing.candidateDigest !== candidateDigest) {
        throw new Error('A different sealed artifact won the commit race.');
      }
    }
    return manifest.artifactDigest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createBuildJobHandler() {
  return async (job: JobRecord): Promise<void> => {
    const { releaseId, candidateDigest } = validJobInput(job);
    const stored = readRelease(releaseId);
    if (stored.release.candidateDigest !== candidateDigest || computeCandidateDigest(stored.snapshot) !== candidateDigest) {
      throw new Error('Build candidate digest does not match the frozen release.');
    }
    if (stored.release.status === 'preview_ready') {
      const sealedRoot = findSealedArtifactRoot(releaseId);
      if (!sealedRoot) throw new Error('Preview-ready release has no sealed artifact.');
      const manifest = await verifyArtifactTree(sealedRoot);
      if (manifest.candidateDigest === candidateDigest) return;
      throw new Error('Sealed artifact belongs to a different candidate.');
    }
    if (!verifyBackupProof(stored.release.backupProof, stored.release)) {
      throw new Error('Candidate backup proof is required before building its public preview.');
    }

    const stagingParent = buildRoot();
    await fs.mkdir(stagingParent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(stagingParent, `release-${releaseId}-`));
    const inputDirectory = path.join(staging, 'input');
    const outputDirectory = path.join(staging, 'output');
    await fs.mkdir(inputDirectory);
    try {
      const frozenInput = await writeFrozenInput(stored.release, stored.snapshot, candidateDigest, inputDirectory);
      await execPublicBuild(frozenInput, outputDirectory, candidateDigest);
      const artifactDigest = await sealBuildOutput(releaseId, outputDirectory, candidateDigest);
      const current = readRelease(releaseId);
      const publishing = createEditorPublishingService();
      await publishing.markPreviewReady(releaseId, {
        artifactDigest,
        backupProof: current.release.backupProof,
      });
    } catch (error) {
      const publishing = createEditorPublishingService();
      await publishing.markPreviewFailed(releaseId, error instanceof Error ? error.message : 'Public build failed.');
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export async function enqueueCandidateBuild(releaseId: string, candidateDigest: string): Promise<JobRecord> {
  return withRuntimeDataRootLock(() => createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), {
    type: 'build',
    id: `build-${releaseId}`,
    input: { releaseId, candidateDigest },
  }));
}
