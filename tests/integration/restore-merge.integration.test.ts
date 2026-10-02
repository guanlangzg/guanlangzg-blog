import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '@/app/types/article';
import { createArticleSlug } from '@/lib/article-data';
import { readArticlesFromDisk, readNavigationFromDisk, readSiteSettingsFromDisk } from '@/lib/editor-data-storage';
import { readEditorMediaManifest } from '@/lib/editor-media-storage';
import { listJobs } from '@/lib/jobs/store';
import { createRestorePlan, type RestorableEditorData } from '@/lib/restoring/plan';
import {
  applyRestorePlan,
  type RestoreApplyDependencies,
} from '@/lib/restoring/apply';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@/lib/site-settings';

const ORIGINAL_BLOG_DATA_ROOT = process.env.BLOG_DATA_ROOT;
const tempDirectories: string[] = [];
const PNG_ONE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG_TWO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-restore-'));
  tempDirectories.push(root);
  return root;
}

function mediaAsset(bytes: Uint8Array, filePath: string) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    id: hash,
    path: filePath,
    publicPath: `/media/${filePath}`,
    mimeType: 'image/png' as const,
    size: bytes.byteLength,
    hash,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

function article(id: string, content: string): Article {
  const base: Article = {
    id,
    title: id,
    date: '2026-06-01',
    description: '',
    tags: [],
    content,
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    ...base,
    slug: createArticleSlug(base),
    kind: 'essay',
    status: 'published',
    featured: false,
    sourceLinks: [],
    revisionNotes: [],
  };
}

function data(input: Omit<Partial<RestorableEditorData>, 'settings'> & { settings?: Partial<SiteSettings> } = {}): RestorableEditorData {
  return {
    articles: input.articles ?? [],
    navigation: input.navigation ?? [],
    settings: { ...DEFAULT_SITE_SETTINGS, ...(input.settings as Partial<SiteSettings> | undefined) },
    navigationIdentities: input.navigationIdentities ?? null,
    media: input.media ?? { manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [] }, files: [] },
  };
}

function depsFor(input: {
  current: RestorableEditorData;
  backup: RestorableEditorData;
  revision?: string;
}): RestoreApplyDependencies {
  let current = input.current;
  const revision = input.revision ?? 'revision-1';
  return {
    readCurrent: async () => ({ data: current, revision }),
    readBackup: async (commit) => ({ data: input.backup, commit }),
    withLock: async (operation) => operation(),
    takeProtectionCopy: async () => undefined,
    stage: async (merged) => merged,
    validateStage: async (staged) => staged as RestorableEditorData,
    applyAtomically: async (merged) => { current = merged; },
    readBackupState: async () => ({ generation: 'generation-next', backedUpThrough: 0, contentSequence: 1 }),
  };
}

async function apply(input: {
  current: RestorableEditorData;
  backup: RestorableEditorData;
  choices?: Array<{ conflictId: string; resolution: 'keep-current' | 'use-backup' | 'keep-both' }>;
  revision?: string;
  deps?: RestoreApplyDependencies;
}) {
  const backupCommit = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const plan = createRestorePlan(input.current, input.backup, {
    currentRevision: input.revision ?? 'revision-1',
    backupCommit,
  });
  const dependencies = input.deps ?? depsFor({
    current: input.current,
    backup: input.backup,
    revision: input.revision,
  });
  const resolvedChoices = (input.choices ?? []).map((choice) => ({
    ...choice,
    conflictId: choice.conflictId.startsWith('article-id:')
      ? plan.conflicts.find((item) => item.kind === 'article-id')?.conflictId ?? choice.conflictId
      : choice.conflictId,
  }));
  const result = await applyRestorePlan(plan, resolvedChoices, dependencies);
  return { result, plan, dependencies, backupCommit };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_BLOG_DATA_ROOT === undefined) delete process.env.BLOG_DATA_ROOT;
  else process.env.BLOG_DATA_ROOT = ORIGINAL_BLOG_DATA_ROOT;
  while (tempDirectories.length > 0) fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
});

describe('restore merge application', () => {
  it('rejects missing conflict choices with a 422-style error before staging', async () => {
    const current = data({ articles: [article('same', 'current')] });
    const backup = data({ articles: [article('same', 'backup')] });
    const dependencies = depsFor({ current, backup });
    const stage = vi.spyOn(dependencies, 'stage');
    const plan = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });

    await expect(applyRestorePlan(plan, [], dependencies)).rejects.toMatchObject({ status: 422, code: 'INVALID_SELECTION' });
    expect(stage).not.toHaveBeenCalled();
  });

  it('keeps exact current bytes or takes backup bytes for a same-ID conflict', async () => {
    const current = data({ articles: [article('same', 'current bytes')] });
    const backup = data({ articles: [article('same', 'backup bytes')] });
    const conflictId = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    }).conflicts.find((item) => item.kind === 'article-id')!.conflictId;
    const keep = await apply({ current, backup, choices: [{ conflictId, resolution: 'keep-current' }] });
    const use = await apply({ current, backup, choices: [{ conflictId, resolution: 'use-backup' }] });

    expect(keep.result.data.articles[0]?.content).toBe('current bytes');
    expect(use.result.data.articles[0]?.content).toBe('backup bytes');
  });

  it('allows keep-both for articles and refuses it for single-value settings', async () => {
    const current = data({ articles: [article('same', 'current')], settings: { siteName: 'Current' } });
    const backup = data({ articles: [article('same', 'backup')], settings: { siteName: 'Backup' } });
    const plan = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const articleConflict = plan.conflicts.find((item) => item.kind === 'article-id');
    const settingConflict = plan.conflicts.find((item) => item.kind === 'settings-field');

    const keptBoth = await apply({ current, backup, choices: [
      { conflictId: articleConflict!.conflictId, resolution: 'keep-both' },
      { conflictId: settingConflict!.conflictId, resolution: 'keep-current' },
    ] });
    expect(keptBoth.result.data.articles).toHaveLength(2);

    await expect(apply({ current, backup, choices: [
      { conflictId: articleConflict!.conflictId, resolution: 'keep-current' },
      { conflictId: settingConflict!.conflictId, resolution: 'keep-both' },
    ] })).rejects.toMatchObject({ status: 422, code: 'INVALID_SELECTION' });
  });

  it('preserves the complete media union and rewrites only parsed backup media links', async () => {
    const currentUnique = mediaAsset(PNG_ONE, 'files/2026/06/current-unreferenced.png');
    const backupUnique = mediaAsset(PNG_TWO, 'files/2026/06/backup-unreferenced.png');
    const current = data({ media: {
      manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [currentUnique] },
      files: [{ path: currentUnique.path, bytes: PNG_ONE }],
    } });
    const backup = data({ media: {
      manifest: { version: 1, updatedAt: '2026-06-02T00:00:00.000Z', assets: [backupUnique] },
      files: [{ path: backupUnique.path, bytes: PNG_TWO }],
    } });
    const applied = await apply({ current, backup });

    expect(applied.result.data.media?.manifest.assets.map((asset) => asset.path)).toEqual([
      backupUnique.path,
      currentUnique.path,
    ]);
    expect(applied.result.data.media?.files?.map((file) => file.path)).toEqual([
      backupUnique.path,
      currentUnique.path,
    ]);

    const sharedPath = 'files/2026/06/shared.png';
    const sharedCurrent = mediaAsset(PNG_ONE, sharedPath);
    const sharedBackup = mediaAsset(PNG_TWO, sharedPath);
    const mediaUrl = `/media/${sharedPath}`;
    const backupMarkdown = [`[label](${mediaUrl})`, '', '```md', `![code](${mediaUrl})`, '```'].join('\n');
    const backupArticle = article('backup-link', backupMarkdown);
    const conflictData = data({
      articles: [article('current-link', `![current](${mediaUrl})`)],
      media: {
        manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [sharedCurrent] },
        files: [{ path: sharedPath, bytes: PNG_ONE }],
      },
    });
    const conflictingBackup = data({
      articles: [backupArticle],
      media: {
        manifest: { version: 1, updatedAt: '2026-06-02T00:00:00.000Z', assets: [sharedBackup] },
        files: [{ path: sharedPath, bytes: PNG_TWO }],
      },
    });
    const conflictPlan = createRestorePlan(conflictData, conflictingBackup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const mediaConflict = conflictPlan.conflicts.find((item) => item.kind === 'media-path')!;
    const movedPath = `files/restored/${sharedBackup.hash}.png`;
    const conflictResult = await apply({
      current: conflictData,
      backup: conflictingBackup,
      choices: [{ conflictId: mediaConflict.conflictId, resolution: 'keep-current' }],
    });
    const restoredBackupArticle = conflictResult.result.data.articles.find((item) => item.id === 'backup-link');

    expect(restoredBackupArticle?.content).toBe([
      `[label](${mediaUrl.replace(sharedPath, movedPath)})`,
      '',
      '```md',
      `![code](${mediaUrl})`,
      '```',
    ].join('\n'));
    expect(conflictResult.result.data.media.files.map((file) => file.path)).toContain(movedPath);
  });

  it('rewrites both the inner image and the outer destination of a link wrapping the same media', async () => {
    const sharedPath = 'files/2026/06/shared.png';
    const sharedCurrent = mediaAsset(PNG_ONE, sharedPath);
    const sharedBackup = mediaAsset(PNG_TWO, sharedPath);
    const mediaUrl = `/media/${sharedPath}`;
    const current = data({
      articles: [article('current-link', `![current](${mediaUrl})`)],
      media: {
        manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [sharedCurrent] },
        files: [{ path: sharedPath, bytes: PNG_ONE }],
      },
    });
    const backup = data({
      articles: [article('wrapped', `[![cover](${mediaUrl})](${mediaUrl})`)],
      media: {
        manifest: { version: 1, updatedAt: '2026-06-02T00:00:00.000Z', assets: [sharedBackup] },
        files: [{ path: sharedPath, bytes: PNG_TWO }],
      },
    });
    const plan = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const mediaConflict = plan.conflicts.find((item) => item.kind === 'media-path')!;
    const movedPath = `files/restored/${sharedBackup.hash}.png`;

    const result = await apply({
      current,
      backup,
      choices: [{ conflictId: mediaConflict.conflictId, resolution: 'keep-current' }],
    });

    const restored = result.result.data.articles.find((item) => item.id === 'wrapped');
    expect(restored?.content).toBe(`[![cover](${mediaUrl.replace(sharedPath, movedPath)})](${mediaUrl.replace(sharedPath, movedPath)})`);
  });

  it('returns 409 after a local revision change without applying data', async () => {
    const current = data({ articles: [article('local', 'before')] });
    const backup = data({ articles: [article('backup', 'backup')] });
    const dependencies = depsFor({ current, backup });
    let currentNow = current;
    let revisionNow = 'revision-1';
    dependencies.readCurrent = async () => ({ data: currentNow, revision: revisionNow });
    const applied = vi.spyOn(dependencies, 'applyAtomically');
    const plan = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    currentNow = data({ articles: [article('local', 'after local edit')] });
    revisionNow = 'revision-2';

    await expect(applyRestorePlan(plan, [], dependencies)).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(currentNow.articles[0]?.content).toBe('after local edit');
    expect(applied).not.toHaveBeenCalled();
  });

  it('rejects unsafe media paths during staging validation without applying', async () => {
    const bytes = PNG_ONE;
    const unsafe = mediaAsset(bytes, 'files/../../outside.png');
    const current = data();
    const backup = data({ media: {
      manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [unsafe] },
      files: [{ path: unsafe.path, bytes }],
    } });
    const dependencies = depsFor({ current, backup });
    let applyCount = 0;
    dependencies.applyAtomically = async () => { applyCount += 1; };

    await expect(apply({ current, backup, deps: dependencies })).rejects.toMatchObject({ status: 422, code: 'INVALID_BACKUP' });
    expect(applyCount).toBe(0);
  });

  it('applies through existing restore transaction without publish or remote branch movement', async () => {
    const root = tempRoot();
    process.env.BLOG_DATA_ROOT = root;
    const current = data({ articles: [article('current', 'current')] });
    const backup = data({ articles: [article('backup', 'backup')] });
    let publishCount = 0;
    const dependencies = depsFor({ current, backup });
    dependencies.withLock = undefined;
    dependencies.stage = undefined;
    dependencies.validateStage = undefined;
    dependencies.applyAtomically = undefined;
    const applied = await apply({ current, backup, deps: dependencies });

    expect(applied.result.data.articles.map((item) => item.id)).toEqual(['current', 'backup']);
    expect(readArticlesFromDisk().map((item) => item.id)).toEqual(['current', 'backup']);
    expect(readNavigationFromDisk()).toEqual([]);
    expect(readSiteSettingsFromDisk()).toEqual(DEFAULT_SITE_SETTINGS);
    expect(readEditorMediaManifest().assets).toEqual([]);
    expect(await listJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'backup', input: expect.objectContaining({ resource: 'restore' }) }),
    ]));
    expect(publishCount).toBe(0);
    expect(applied.result.generation).toEqual(expect.any(String));
    expect(applied.result.backupCaughtUp).toBe(false);
  });
});
