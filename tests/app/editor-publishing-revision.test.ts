import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as getRevision } from '@/app/api/editor/publishing-revision/route';
import { POST as postRelease } from '@/app/api/editor/releases/route';
import { resetEnvironmentEditorSessionForTests } from '@/lib/editor-auth-runtime';
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
    createdAt: 1,
    updatedAt: 2,
  };
}

function seedRuntimeData(dataRoot: string): void {
  writeJson(path.join(dataRoot, 'articles', 'articles.json'), [createArticle('article-1', 'First Article')]);
  writeJson(path.join(dataRoot, 'navigation', 'tools.json'), []);
  writeJson(path.join(dataRoot, 'settings', 'site.json'), {
    siteName: 'Revision Test',
    siteDescription: 'Revision Test description',
    workspaceLabel: 'workspace / test',
    heroTitleLineOne: 'Hero One',
    heroTitleLineTwo: 'Hero Two',
    heroDescription: 'Hero description',
  });
}

beforeEach(() => {
  const dataRoot = createTempDirectory('blog-publishing-revision-');
  tempDirectories.push(dataRoot);
  process.env.BLOG_DATA_ROOT = dataRoot;
  process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
});

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  resetEnvironmentEditorSessionForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('publishing revision endpoint', () => {
  // Regression: the endpoint and the publishing service must agree on every
  // scope's revision, or the UI can never create a candidate (always 409).
  it('accepts candidate creation for every scope using the revisions it reports', async () => {
    seedRuntimeData(process.env.BLOG_DATA_ROOT!);

    const revisionResponse = await getRevision(
      await createAuthedEditorRequest('http://localhost/api/editor/publishing-revision')
    );
    expect(revisionResponse.status).toBe(200);
    const { revisions } = (await revisionResponse.json()) as {
      revisions: Record<string, string>;
    };

    expect(revisions.article).toBeTruthy();
    expect(revisions.navigation).toBeTruthy();
    expect(revisions.settings).toBeTruthy();
    expect(revisions.bootstrap).toBeTruthy();

    const payloads = [
      { scope: { kind: 'article', articleId: 'article-1', action: 'publish' }, expectedRevision: revisions.article },
      { scope: { kind: 'navigation' }, expectedRevision: revisions.navigation },
      { scope: { kind: 'settings' }, expectedRevision: revisions.settings },
      { scope: { kind: 'bootstrap', articleIds: ['article-1'] }, expectedRevision: revisions.bootstrap },
    ];

    for (const payload of payloads) {
      const request = await createAuthedEditorRequest('http://localhost/api/editor/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const response = await postRelease(request);

      expect(response.status, `scope ${String(payload.scope.kind)} must accept its reported revision`).toBe(202);
      expect(await response.json()).toEqual(expect.objectContaining({ releaseId: expect.any(String) }));
    }
  });

  it('rejects candidate creation when the expected revision no longer matches', async () => {
    seedRuntimeData(process.env.BLOG_DATA_ROOT!);

    const request = await createAuthedEditorRequest('http://localhost/api/editor/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'navigation' }, expectedRevision: 'stale-revision' }),
    });
    const response = await postRelease(request);

    expect(response.status).toBe(409);
  });
});
