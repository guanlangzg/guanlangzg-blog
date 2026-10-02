import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Article } from '@/app/types/article';
import { encodeBackupSnapshot, type BackupSnapshotInput } from '@/lib/github/backup';
import {
  createGitHubArticleHistoryApi,
  listArticleHistory,
  restoreArticleHistoryVersion,
  type ArticleHistoryApi,
} from '@/lib/history/articles';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { EditorMediaManifest } from '@/lib/editor-media-storage';

function article(id: string, content: string, slug = 'history-article'): Article {
  return {
    id,
    slug,
    title: '历史文章',
    date: '2026-09-30',
    description: '摘要',
    tags: ['历史'],
    content,
    createdAt: 1,
    updatedAt: 2,
    status: 'draft',
  };
}

function encodedArticle(value: Article): Map<string, Uint8Array> {
  const input: BackupSnapshotInput = {
    snapshotId: 'history-snapshot',
    siteId: 'site-1',
    articles: [value],
    navigation: [],
    navigationIdentities: createNavigationIdentityMap([]),
    settings: { ...DEFAULT_SITE_SETTINGS },
    mediaManifest: { version: 1, updatedAt: '2026-09-30T00:00:00.000Z', assets: [] },
    mediaObjects: [],
    publication: { live: null, liveSnapshot: null, candidate: null },
  };
  return encodeBackupSnapshot(input).files;
}

function apiForVersions(versions: Array<{
  sha: string;
  message: string;
  date: string;
  files: Map<string, Uint8Array>;
}>, listedPaths: string[] = []): ArticleHistoryApi {
  return {
    async listCommits(path, page, perPage) {
      listedPaths.push(`${path}?page=${page}&per_page=${perPage}`);
      const start = (page - 1) * perPage;
      const selected = versions.slice(start, start + perPage);
      return {
        commits: selected.map((version) => ({
          sha: version.sha,
          message: version.message,
          committedAt: version.date,
        })),
        nextPage: start + selected.length < versions.length ? page + 1 : null,
      };
    },
    async readFile(filePath, commitSha) {
      const version = versions.find((item) => item.sha === commitSha);
      const bytes = version?.files.get(filePath);
      if (!bytes) throw new Error(`missing file ${filePath}`);
      return bytes;
    },
  };
}

const emptyMedia: EditorMediaManifest = {
  version: 1,
  updatedAt: '2026-09-30T00:00:00.000Z',
  assets: [],
};

describe('per-article backup history', () => {
  it('paginates commits by stable article directory and returns diffable version summaries', async () => {
    const original = article('article-history-id', '第一版\r\n');
    const changed = article('article-history-id', '第二版\r\n');
    const idDirectory = createHash('sha256').update(original.id).digest('hex');
    const versions = [
      { sha: 'commit-2', message: 'edit second', date: '2026-09-30T02:00:00.000Z', files: encodedArticle(changed) },
      { sha: 'commit-1', message: 'edit first', date: '2026-09-30T01:00:00.000Z', files: encodedArticle(original) },
    ];
    const listedPaths: string[] = [];
    const api = apiForVersions(versions, listedPaths);

    const firstPage = await listArticleHistory(api, original.id, { page: 1, perPage: 1 });
    const secondPage = await listArticleHistory(api, original.id, { page: 2, perPage: 1 });

    expect(listedPaths).toEqual([
      `articles/${idDirectory}?page=1&per_page=1`,
      `articles/${idDirectory}?page=2&per_page=1`,
    ]);
    expect(firstPage.versions[0]).toEqual(expect.objectContaining({
      commitSha: 'commit-2',
      article: changed,
      summary: expect.objectContaining({ content: '第二版\r\n', contentDigest: expect.any(String) }),
    }));
    expect(secondPage.versions[0].article.content).toBe('第一版\r\n');
  });

  it('encodes the stable article history path exactly once in the GitHub query', async () => {
    let requestedUrl = '';
    const api = createGitHubArticleHistoryApi({
      repository: { owner: 'owner', name: 'backup', id: 30 },
      tokenProvider: { getToken: async () => 'fake-token' },
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await api.listCommits('articles/id%with space', 1, 20);

    expect(new URL(requestedUrl).searchParams.get('path')).toBe('articles/id%with space');
  });

  it('restores as a protected current draft without changing remote history or scheduling publish', async () => {
    const restored = article('article-history-id', '旧版正文');
    const files = encodedArticle(restored);
    const directory = createHash('sha256').update(restored.id).digest('hex');
    const articleDir = `articles/${directory}`;
    const protectedDrafts: Article[][] = [];
    let currentArticles = [article(restored.id, '未备份的现有草稿')];
    const api = apiForVersions([
      { sha: 'commit-old', message: 'old version', date: '2026-09-29T00:00:00.000Z', files },
    ]);
    const readFile = vi.spyOn(api, 'readFile');
    const listCommits = vi.spyOn(api, 'listCommits');

    const result = await restoreArticleHistoryVersion(api, {
      articleId: restored.id,
      commitSha: 'commit-old',
    }, {
      currentArticles: async () => currentArticles,
      protectDraft: async (draft) => { protectedDrafts.push(structuredClone(draft)); },
      writeDrafts: async (next) => { currentArticles = next; return true; },
      mediaManifest: async () => emptyMedia,
      validateManagedMedia: async () => undefined,
      now: () => new Date('2026-09-30T03:00:00.000Z'),
    });

    expect(protectedDrafts[0][0].content).toBe('未备份的现有草稿');
    expect(result.id).toBe(restored.id);
    expect(result.status).toBe('draft');
    expect(currentArticles).toEqual([result]);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(listCommits).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith(`${articleDir}/content.md`, 'commit-old');
    expect([...files.get(`${articleDir}/content.md`)!]).toEqual([...Buffer.from('旧版正文')]);
  });

  it('rejects a restore with missing managed media before protecting or writing the draft', async () => {
    const value = article('article-with-media', '![image](/media/files/missing.png)');
    const files = encodedArticle(value);
    const protectedDraft = vi.fn(async () => undefined);
    const writeDrafts = vi.fn(async () => true);
    const api = apiForVersions([
      { sha: 'commit-media', message: 'with media', date: '2026-09-29T00:00:00.000Z', files },
    ]);

    await expect(restoreArticleHistoryVersion(api, {
      articleId: value.id,
      commitSha: 'commit-media',
    }, {
      currentArticles: async () => [],
      protectDraft: protectedDraft,
      writeDrafts,
      mediaManifest: async () => emptyMedia,
      validateManagedMedia: async (articleValue, manifest) => {
        if (articleValue.content.includes('/media/files/missing.png') && manifest.assets.length === 0) {
          throw new Error('Managed media reference is missing: files/missing.png');
        }
      },
    })).rejects.toThrow(/Managed media reference is missing/);

    expect(protectedDraft).not.toHaveBeenCalled();
    expect(writeDrafts).not.toHaveBeenCalled();
  });
});
