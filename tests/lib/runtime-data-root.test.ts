import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTempDirectories,
  createTempDirectory,
} from '../helpers/api-route';
import {
  isRuntimeDataRootAvailable,
  isRuntimeDataRootAvailableSync,
  isRuntimeDataRootWritable,
  isRuntimeDataRootWritableSync,
} from '@/lib/runtime-data-root';

const tempDirectories: string[] = [];

function createTempRoot(): string {
  const root = createTempDirectory('blog-navigation-runtime-data-root-');
  tempDirectories.push(root);
  return root;
}

afterEach(() => {
  cleanupTempDirectories(tempDirectories);
});

describe('runtime data root writability', () => {
  it('treats an existing writable directory as writable', async () => {
    const root = createTempRoot();

    await expect(isRuntimeDataRootWritable(root)).resolves.toBe(true);
    expect(isRuntimeDataRootWritableSync(root)).toBe(true);
  });

  it('treats a missing directory under a writable parent as writable', async () => {
    const root = createTempRoot();
    const missingRoot = path.join(root, 'runtime', 'data');

    expect(fs.existsSync(missingRoot)).toBe(false);
    await expect(isRuntimeDataRootWritable(missingRoot)).resolves.toBe(true);
    expect(isRuntimeDataRootWritableSync(missingRoot)).toBe(true);
  });

  it('treats a path blocked by a file as not writable', async () => {
    const root = createTempRoot();
    const blockingFile = path.join(root, 'blocked.txt');
    const blockedRoot = path.join(blockingFile, 'runtime-data');

    fs.writeFileSync(blockingFile, 'blocked', 'utf8');

    await expect(isRuntimeDataRootWritable(blockedRoot)).resolves.toBe(false);
    expect(isRuntimeDataRootWritableSync(blockedRoot)).toBe(false);
  });
});

describe('runtime data root availability', () => {
  it('treats an existing directory as available', async () => {
    const root = createTempRoot();

    await expect(isRuntimeDataRootAvailable(root)).resolves.toBe(true);
    expect(isRuntimeDataRootAvailableSync(root)).toBe(true);
  });

  it('treats a missing directory under a writable parent as available', async () => {
    const root = createTempRoot();
    const missingRoot = path.join(root, 'runtime', 'data');

    expect(fs.existsSync(missingRoot)).toBe(false);
    await expect(isRuntimeDataRootAvailable(missingRoot)).resolves.toBe(true);
    expect(isRuntimeDataRootAvailableSync(missingRoot)).toBe(true);
  });

  it('treats a path blocked by a file as unavailable', async () => {
    const root = createTempRoot();
    const blockingFile = path.join(root, 'blocked.txt');
    const blockedRoot = path.join(blockingFile, 'runtime-data');

    fs.writeFileSync(blockingFile, 'blocked', 'utf8');

    await expect(isRuntimeDataRootAvailable(blockedRoot)).resolves.toBe(false);
    expect(isRuntimeDataRootAvailableSync(blockedRoot)).toBe(false);
  });
});
