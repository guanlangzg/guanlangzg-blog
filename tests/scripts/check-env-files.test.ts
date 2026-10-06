import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const checkScript = path.join(repoRoot, 'scripts', 'test', 'check-env-files.mjs');
const sandboxes: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

// The gate inspects files tracked by git, so the fixture is a throwaway repository
// with its own index instead of anything inside the project work tree.
function createTrackedRepo(trackedFiles: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-check-'));
  sandboxes.push(root);
  git(root, 'init', '--quiet', '--initial-branch', 'main');
  for (const file of trackedFiles) {
    const filePath = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'PLACEHOLDER=1\n');
  }
  if (trackedFiles.length > 0) git(root, 'add', '--', ...trackedFiles);
  return root;
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [checkScript], { cwd, encoding: 'utf8' });
}

afterEach(() => {
  while (sandboxes.length > 0) {
    fs.rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

describe('tracked environment file gate', () => {
  const forbiddenFiles = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    '.env.test',
    '.env.staging',
    '.env.production.local',
    '.env.staging.local',
    'deploy/.env',
    'config/.env.ci',
  ];

  it.each(forbiddenFiles)('rejects a tracked %s', (file) => {
    const result = runCheck(createTrackedRepo([file]));

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(file);
  });

  it('accepts a repository without tracked environment files', () => {
    const result = runCheck(createTrackedRepo(['README.md', 'src/app.ts', 'config/app.env.example']));

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('keeps the documented example file allowed', () => {
    const result = runCheck(createTrackedRepo(['.env.example']));

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('reports every offending file in one run', () => {
    const result = runCheck(createTrackedRepo(['.env', 'deploy/.env.production']));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.env');
    expect(result.stderr).toContain('deploy/.env.production');
  });
});
