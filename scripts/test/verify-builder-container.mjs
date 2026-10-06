#!/usr/bin/env node
// Verifies the FINAL runner image, not the builder stage: the isolated public build
// must succeed inside the shipped image with no network, as the non-root app user
// created by the image entrypoint, driven by a disposable fixture this script writes
// itself. Exit code 2 means Docker is unavailable and nothing was verified - that is
// never a pass. Nothing here reads or writes the local frozen release fixture or any
// runtime data root: the fixture below is disposable and lives in the OS temp dir.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultImage = 'guanlangzg-blog-runner:local';
const image = (process.env.RUNNER_IMAGE || process.env.BUILDER_IMAGE || '').trim() || defaultImage;
// CI builds and loads the image itself, so the check only runs inside it there.
const skipBuild = process.env.RUNNER_SKIP_BUILD === '1';
const fixtureReleaseId = 'runner-verify';
const containerFixtureRoot = '/fixture';
const containerOutputRoot = '/var/lib/guanlan/build/runner-verify-output';

function dockerExecutable() {
  // `docker.exe` must be resolved explicitly to avoid shell:true (which would let
  // shell metacharacters in paths reach the command line).
  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

function hasDocker() {
  const probe = spawnSync(dockerExecutable(), ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function runDocker(args, label) {
  const result = spawnSync(dockerExecutable(), args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 3_600_000,
  });
  if (result.error) {
    process.stderr.write(`${label} could not run: ${result.error.message}\n`);
    return { status: 1 };
  }
  if (result.status !== 0) {
    process.stderr.write(`${label} failed with exit ${result.status}\n`);
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// A frozen snapshot plus the candidate identity the build CLI demands. The fixture is
// disposable and lives in the OS temp directory so a run can never consume or mutate
// the frozen first-release fixture.
function writeFixture(fixtureRoot) {
  const snapshot = {
    releaseId: fixtureReleaseId,
    site: { title: '观澜志', description: '运行镜像离线公开构建验证' },
    posts: [{
      slug: fixtureReleaseId,
      title: '运行镜像离线公开构建验证',
      description: '在最终运行镜像内以非 root 用户离线构建公开站。',
      date: '2026-10-06',
      tags: ['验证'],
      content: '# 运行镜像离线公开构建验证\n\n这段正文只存在于一次性夹具中。\n',
    }],
    navigation: [],
  };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const snapshotDigest = sha256(snapshotBytes);
  const candidateDigest = sha256(`${fixtureReleaseId}-candidate`);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'snapshot.json'), snapshotBytes);
  fs.writeFileSync(
    path.join(fixtureRoot, 'candidate-identity.json'),
    JSON.stringify({ schemaVersion: 1, releaseId: fixtureReleaseId, candidateDigest, snapshotDigest }),
  );
  return { candidateDigest, snapshotDigest };
}

// Every assertion runs through the real entrypoint, so one run proves the runner
// source closure, the privilege drop and the offline dependency set together.
function containerCheck({ candidateDigest, snapshotDigest }) {
  const releaseOutput = `${containerOutputRoot}/${fixtureReleaseId}/app/out`;
  const buildCommand = [
    'node /app/scripts/public-site/build.mjs',
    `--snapshot ${containerFixtureRoot}/snapshot.json`,
    `--identity ${containerFixtureRoot}/candidate-identity.json`,
    `--candidate-digest ${candidateDigest}`,
    `--snapshot-digest ${snapshotDigest}`,
    `--out ${containerOutputRoot}`,
  ].join(' ');
  return [
    'set -eu',
    'echo "container build user: $(id -un) uid=$(id -u)"',
    'test "$(id -u)" != "0"',
    buildCommand,
    `test -s ${releaseOutput}/index.html`,
    // These two routes were missing from the runner source closure before.
    `test -s ${releaseOutput}/llms.txt`,
    `test -s ${releaseOutput}/manifest.webmanifest`,
  ].join('\n');
}

function toDockerPath(value) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
}

async function main() {
  if (!hasDocker()) {
    process.stderr.write(
      'Docker is unavailable on this machine — in-container verification NOT PERFORMED.\n'
      + 'No runner image was built and no public build ran inside a container. Do not report this gate as passed.\n'
    );
    process.exitCode = 2;
    return;
  }

  if (skipBuild) {
    const inspected = runDocker(['image', 'inspect', image], `runner image ${image}`);
    if (inspected.status !== 0) {
      process.stderr.write(`RUNNER_SKIP_BUILD=1 needs an already built local image: ${image}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    const built = runDocker(['build', '--target', 'runner', '-t', image, '.'], 'runner image build');
    if (built.status !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'guanlan-runner-verify-'));
  try {
    const digests = writeFixture(fixtureRoot);
    // The container command runs as the non-root nextjs user because the image
    // entrypoint drops privileges; --entrypoint is deliberately left untouched.
    const result = runDocker([
      'run', '--rm',
      '--network=none',
      '--memory', '2g',
      '--mount', `type=bind,source=${toDockerPath(fixtureRoot)},target=${containerFixtureRoot},readonly`,
      image,
      'sh', '-c', containerCheck(digests),
    ], 'in-container public build');

    process.stdout.write(result.status === 0
      ? `Runner image ${image} built and sealed the public site offline as the non-root app user.\n`
      : 'In-container public build failed; see output above.\n');
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
