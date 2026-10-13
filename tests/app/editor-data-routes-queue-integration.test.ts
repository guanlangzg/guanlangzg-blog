import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getArticles, PUT as putArticles } from '@/app/api/data/articles/route';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = createTempDirectory('blog-navigation-editor-data-backup-');
  tempDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

const article = (id: string, title: string) => ({
  id,
  title,
  date: '2026-05-24',
  description: `${title} description`,
  tags: ['test'],
  content: `# ${title}`,
  slug: id,
  createdAt: 1,
  updatedAt: 2,
});

function seedRuntimeData(dataRoot: string): void {
  writeJson(path.join(dataRoot, 'articles', 'articles.json'), [article('article-1', 'First Article')]);
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

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

describe('editor article write route', () => {
  it('persists a valid article update', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    seedRuntimeData(process.env.BLOG_DATA_ROOT);
    const current = await (await getArticles(await createAuthedEditorRequest('http://localhost/api/data/articles'))).json();
    const response = await putArticles(
      await createAuthedEditorRequest('http://localhost/api/data/articles', {
        method: 'PUT',
        body: JSON.stringify({
          revision: current.revision,
          articles: [article('article-2', 'Next Article')],
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      success: true,
      revision: expect.any(String),
    });
    expect(JSON.parse(fs.readFileSync(path.join(process.env.BLOG_DATA_ROOT, 'articles', 'articles.json'), 'utf8'))).toEqual([
      expect.objectContaining({ id: 'article-2' }),
    ]);
  });
});
