import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeArticlesToDisk } from '@/lib/editor-data-storage';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-runtime-data-lock-');

  tempDirectories.push(directory);
  return directory;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createArticle(id: string, title: string) {
  return {
    id,
    title,
    date: '2026-05-24',
    description: `${title} description`,
    tags: ['test'],
    content: `# ${title}`,
    slug: id,
    createdAt: 1,
    updatedAt: 2,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('runtime data root lock', () => {
  it('serializes concurrent top-level operations instead of treating them as reentrant', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const order: string[] = [];
    let releaseFirstOperation: (() => void) | undefined;
    const firstOperationBlocked = new Promise<void>((resolve) => {
      releaseFirstOperation = () => resolve();
    });

    const firstOperation = withRuntimeDataRootLock(async () => {
      order.push('first-start');
      await firstOperationBlocked;
      order.push('first-end');
    });

    await sleep(0);

    const secondOperation = withRuntimeDataRootLock(async () => {
      order.push('second-start');
      order.push('second-end');
    });

    await sleep(50);
    expect(order).toEqual(['first-start']);

    releaseFirstOperation?.();

    await Promise.all([firstOperation, secondOperation]);

    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  it('allows nested calls in the same async flow without deadlocking', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const order: string[] = [];

    await withRuntimeDataRootLock(async () => {
      order.push('outer-start');

      await withRuntimeDataRootLock(async () => {
        order.push('inner');
      });

      order.push('outer-end');
    });

    expect(order).toEqual([
      'outer-start',
      'inner',
      'outer-end',
    ]);
  });

  it('recovers an incomplete restore before running a top-level runtime data root operation', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const dataRoot = process.env.BLOG_DATA_ROOT;

    if (!dataRoot) {
      throw new Error('Expected BLOG_DATA_ROOT to be set.');
    }

    const originalArticles = [createArticle('article-1', 'Original Article')];
    const mixedArticles = [createArticle('article-2', 'Mixed Article')];
    const backupRoot = path.join(dataRoot, '.restore-backup-test');

    await writeArticlesToDisk(originalArticles);

    fs.mkdirSync(path.join(backupRoot, 'articles'), { recursive: true });
    fs.copyFileSync(
      path.join(dataRoot, 'articles', 'articles.json'),
      path.join(backupRoot, 'articles', 'articles.json')
    );
    fs.copyFileSync(
      path.join(dataRoot, 'manifest.json'),
      path.join(backupRoot, 'manifest.json')
    );
    fs.writeFileSync(
      path.join(dataRoot, '.restore-state.json'),
      JSON.stringify({
        version: 1,
        phase: 'replacing',
        stagingDirectory: path.join(dataRoot, '.restore-staging-test'),
        backupDirectory: backupRoot,
        files: [
          path.join(dataRoot, 'articles', 'articles.json'),
          path.join(dataRoot, 'navigation', 'tools.json'),
          path.join(dataRoot, 'settings', 'site.json'),
          path.join(dataRoot, 'manifest.json'),
        ],
        updatedAt: new Date().toISOString(),
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dataRoot, 'articles', 'articles.json'),
      JSON.stringify(mixedArticles),
      'utf8'
    );

    let observedArticles: unknown[] | null = null;

    await withRuntimeDataRootLock(async () => {
      observedArticles = JSON.parse(
        fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')
      ) as unknown[];
    });

    expect(observedArticles).toEqual(originalArticles);
    expect(fs.existsSync(path.join(dataRoot, '.restore-state.json'))).toBe(false);
  });
});
