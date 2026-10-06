import { spawnSync } from 'node:child_process';

// Any tracked dotenv file is forbidden, so the gate matches the whole `.env` family
// instead of a fixed list. `.env.example` is the documented template and stays allowed.
const dotenvPattern = /(^|\/)\.env($|\.)/;
const allowedDotenvFiles = new Set(['.env.example']);

const result = spawnSync('git', ['ls-files', '-z'], {
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
  .split('\0')
  .map((line) => line.trim())
  .filter(Boolean);

const forbiddenFiles = trackedFiles.filter((file) => {
  if (!dotenvPattern.test(file)) return false;
  return !allowedDotenvFiles.has(file.slice(file.lastIndexOf('/') + 1));
});

if (forbiddenFiles.length > 0) {
  console.error(`Tracked environment files are forbidden: ${forbiddenFiles.join(', ')}`);
  process.exit(1);
}
