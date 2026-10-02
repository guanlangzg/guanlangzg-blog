import { spawnSync } from 'node:child_process';

const forbiddenEnvFiles = [
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
];

const result = spawnSync('git', ['ls-files', ...forbiddenEnvFiles], {
  encoding: 'utf8',
});

if (result.error) {
  console.error(`Failed to inspect tracked environment files: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stderr || 'git ls-files failed.');
  process.exit(result.status ?? 1);
}

const trackedFiles = result.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (trackedFiles.length > 0) {
  console.error(`Tracked environment files are forbidden: ${trackedFiles.join(', ')}`);
  process.exit(1);
}
