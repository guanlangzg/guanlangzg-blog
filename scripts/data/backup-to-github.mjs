#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBackupPayload as createBackupPayloadShared,
  readRuntimeBackupData,
  resolveDataRoot,
} from './runtime-data.mjs';
import {
  createEncryptedBackupPayload,
  getBackupEncryptionSecret,
} from './encrypted-backup.mjs';
function createTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createDefaultOutputPath() {
  return path.resolve('output', 'github-backups', `blog-navigation-backup-${createTimestamp()}.enc.json`);
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createBackupPayload(dataRoot) {
  return createBackupPayloadShared(dataRoot, readRuntimeBackupData(dataRoot));
}

function copyToBackupRepository(encryptedPath) {
  const repoPath = process.env.GITHUB_BACKUP_REPO_PATH?.trim();

  if (!repoPath) {
    return null;
  }

  const resolvedRepoPath = path.resolve(repoPath);
  const targetPath = path.join(resolvedRepoPath, 'backups', path.basename(encryptedPath));
  const targetPathForGit = path.relative(resolvedRepoPath, targetPath);
  ensureParentDirectory(targetPath);
  fs.copyFileSync(encryptedPath, targetPath);

  execFileSync('git', ['-C', resolvedRepoPath, 'add', targetPathForGit], { stdio: 'pipe' });
  const diff = spawnSync('git', ['-C', resolvedRepoPath, 'diff', '--cached', '--quiet', '--', targetPathForGit], {
    stdio: 'pipe',
  });

  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(diff.stderr.toString('utf8') || 'Failed to inspect backup repository diff.');
  }

  if (diff.status === 0) {
    return {
      targetPath,
      committed: false,
      pushed: false,
    };
  }

  execFileSync('git', ['-C', resolvedRepoPath, 'commit', '-m', `backup: add runtime data ${createTimestamp()}`], {
    stdio: 'pipe',
  });

  if (process.env.GITHUB_BACKUP_PUSH === 'true') {
    execFileSync('git', ['-C', resolvedRepoPath, 'push'], { stdio: 'pipe' });
  }

  return {
    targetPath,
    committed: true,
    pushed: process.env.GITHUB_BACKUP_PUSH === 'true',
  };
}

const [dataRootArg, outputArg] = process.argv.slice(2);
const dataRoot = resolveDataRoot(dataRootArg);
const outputPath = path.resolve(outputArg || createDefaultOutputPath());
const encryptedPayload = createEncryptedBackupPayload(
  createBackupPayload(dataRoot),
  getBackupEncryptionSecret()
);

ensureParentDirectory(outputPath);
fs.writeFileSync(outputPath, `${JSON.stringify(encryptedPayload, null, 2)}\n`, 'utf8');

const repositoryBackup = copyToBackupRepository(outputPath);

console.log(JSON.stringify({
  dataRoot,
  outputPath,
  encrypted: true,
  repositoryBackup,
}, null, 2));
