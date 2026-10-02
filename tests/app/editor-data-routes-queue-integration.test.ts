import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getArticles, PUT as putArticles } from '@/app/api/data/articles/route';
import { resetRemoteBackupQueueForTests } from '@/lib/editor-remote-backup';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
  R2_BACKUP_ENABLED: process.env.R2_BACKUP_ENABLED,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-editor-data-queue-');

  tempDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

function seedRuntimeData(dataRoot: string): void {
  writeJson(path.join(dataRoot, 'articles', 'articles.json'), [createArticle('article-1', 'First Article')]);
  writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
  writeJson(path.join(dataRoot, 'settings', 'site.json'), {
    siteName: 'Original Site',
    siteDescription: 'Original Site description',
    workspaceLabel: 'workspace / test',
    heroTitleLineOne: 'Hero One',
    heroTitleLineTwo: 'Hero Two',
    heroDescription: 'Hero description',
  });
}

beforeEach(() => {
  resetRemoteBackupQueueForTests();
});

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  resetRemoteBackupQueueForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('editor data write route queue integration', () => {
  it('keeps article writes successful when the persisted remote backup queue state is corrupt', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
    process.env.R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    fs.writeFileSync(path.join(process.env.BLOG_DATA_ROOT, '.backup-pending.json'), '{', 'utf8');

    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          articles: [createArticle('article-2', 'Next Article')],
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        remoteBackup: {
          queued: false,
          enabled: true,
          success: false,
          queueStateInvalid: true,
          message: '云端备份队列状态文件损坏，请检查并修复。',
        },
      })
    );
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({
        id: 'article-2',
      }),
    ]);
  });
});
