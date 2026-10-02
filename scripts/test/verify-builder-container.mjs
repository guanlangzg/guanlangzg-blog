#!/usr/bin/env node
// Runs the minimal public build INSIDE a container image, so the final runner is
// proven to have the shared sources, locked dependencies and fonts the builder needs.
// Fails fast and explicitly when Docker is unavailable instead of pretending to pass.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(projectRoot, '.tmp', 'first-release-fixture');
const image = process.env.BUILDER_IMAGE || 'guanlangzg-blog-builder:local';

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
    timeout: 1_800_000,
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

async function main() {
  if (!hasDocker()) {
    process.stderr.write(
      'Docker is unavailable on this machine — in-container verification NOT PERFORMED.\n'
      + 'No image was built and no static build ran inside a container. Do not report this gate as passed.\n'
    );
    process.exitCode = 2;
    return;
  }

  await fs.mkdir(fixtureRoot, { recursive: true });
  const candidate = path.join(fixtureRoot, 'candidate.json');
  await fs.access(candidate).catch(() => {
    throw new Error('Run `npm run test:release:fixture` first to generate the frozen snapshot.');
  });

  const built = runDocker(['build', '--target', 'builder', '-t', image, '.'], 'builder image build');
  if (built.status !== 0) return;

  // The in-container build must not reach the network for packages or fonts: the
  // --network=none run proves the image already carries everything it needs.
  const result = runDocker([
    'run', '--rm',
    '--network=none',
    '--memory', '2g',
    '-v', `${fixtureRoot}:/fixture:ro`,
    '--entrypoint', 'node',
    image,
    'scripts/public-site/build.mjs',
    '--snapshot', '/fixture/candidate.json',
    '--out', '/tmp/in-container-out',
  ], 'in-container public build');

  process.stdout.write(result.status === 0
    ? `In-container static build succeeded using image ${image} (no network).\n`
    : 'In-container static build failed; see output above.\n');
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
