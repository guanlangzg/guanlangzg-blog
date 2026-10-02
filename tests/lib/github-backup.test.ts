import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Article } from '@/app/types/article';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import {
  encodeBackupSnapshot,
  writeGitHubBackup,
  type BackupSnapshotInput,
} from '@/lib/github/backup';
import { decodeBackupArticle } from '@/lib/github/backup-decode';
import { GitHubRestClient } from '@/lib/github/client';
import type { GitHubRepositories } from '@/lib/github/config';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';
import type { SiteSnapshot } from '@/lib/publishing/types';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';

const repositories: GitHubRepositories = {
  source: { owner: 'owner', name: 'source', id: 10 },
  pages: { owner: 'owner', name: 'pages', id: 20 },
  backup: { owner: 'owner', name: 'backup', id: 30 },
};

function article(id: string, content: string, extra: Record<string, unknown> = {}): Article {
  return {
    id,
    slug: '观澜-文章',
    title: '中文文章',
    date: '2026-09-30',
    description: '摘要',
    tags: ['备份'],
    content,
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  } as Article;
}

function siteSnapshot(articles: Article[]): SiteSnapshot {
  return {
    schemaVersion: 1,
    siteId: 'site-1',
    articles,
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS },
    media: [],
    redirects: [],
    removedPaths: [],
  };
}

function backupInput(overrides: Partial<BackupSnapshotInput> = {}): BackupSnapshotInput {
  const articles = overrides.articles ?? [article('article-1', '正文')];
  return {
    snapshotId: 'snapshot-fixed-1',
    siteId: 'site-1',
    articles,
    navigation: [],
    navigationIdentities: createNavigationIdentityMap([]),
    settings: { ...DEFAULT_SITE_SETTINGS },
    mediaManifest: { version: 1, updatedAt: '2026-09-30T00:00:00.000Z', assets: [] },
    mediaObjects: [],
    publication: { live: null, liveSnapshot: null, candidate: null },
    ...overrides,
  };
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function createFakeGitHub(options: { privateRepository?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const requests: Array<{ method: string; endpoint: string }> = [];
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  const counts = { patch: 0, commits: 0, writes: 0, blobReads: 0 };
  let advanceBeforePatch = false;
  let loseFirstPatchResponse = false;
  let forceValues: unknown[] = [];
  const initialTreeSha = 'tree-initial';
  trees.set(initialTreeSha, new Map([['README.md', gitBlobSha(new TextEncoder().encode('backup'))]]));
  blobs.set(gitBlobSha(new TextEncoder().encode('backup')), new TextEncoder().encode('backup'));
  const initialCommitSha = 'commit-initial';
  commits.set(initialCommitSha, { treeSha: initialTreeSha, parents: [], message: 'initial' });
  refs.set('main', initialCommitSha);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace('/repos/owner/backup', '');
    const method = init?.method ?? 'GET';
    requests.push({ method, endpoint });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    const currentRef = refs.get('main') as string;

    if (endpoint === '' && method === 'GET') {
      return json({ id: 30, full_name: 'owner/backup', private: options.privateRepository !== false, default_branch: 'main' });
    }
    if (endpoint === '/git/ref/heads/main' && method === 'GET') {
      return json({ ref: 'refs/heads/main', object: { sha: currentRef } });
    }
    if (endpoint.startsWith('/git/commits/')) {
      const sha = endpoint.slice('/git/commits/'.length);
      const commit = commits.get(sha);
      if (!commit) return json({ message: 'not found' }, 404);
      return json({
        sha,
        tree: { sha: commit.treeSha },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        commit: { message: commit.message, author: { date: '2026-09-30T00:00:00Z' } },
      });
    }
    if (endpoint.startsWith('/git/trees/')) {
      const sha = endpoint.slice('/git/trees/'.length).split('?')[0] as string;
      const tree = trees.get(sha);
      if (!tree) return json({ message: 'not found' }, 404);
      return json({
        sha,
        tree: [...tree.entries()].map(([path, blobSha]) => ({ path, mode: '100644', type: 'blob', sha: blobSha })),
        truncated: false,
      });
    }
    if (endpoint.startsWith('/git/blobs/')) {
      counts.blobReads += 1;
      const sha = endpoint.slice('/git/blobs/'.length);
      const bytes = blobs.get(sha);
      return bytes ? json({ sha, encoding: 'base64', content: Buffer.from(bytes).toString('base64') }) : json({ message: 'not found' }, 404);
    }
    if (endpoint === '/git/blobs' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { content: string; encoding: string };
      const bytes = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
      const sha = gitBlobSha(bytes);
      blobs.set(sha, new Uint8Array(bytes));
      counts.writes += 1;
      return json({ sha }, 201);
    }
    if (endpoint === '/git/trees' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { base_tree?: string; tree: Array<{ path: string; sha: string | null }> };
      const next = new Map(trees.get(body.base_tree ?? '') ?? []);
      for (const entry of body.tree) {
        if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, entry.sha);
      }
      const sha = `tree-${counts.writes}-${trees.size}`;
      trees.set(sha, next);
      return json({ sha }, 201);
    }
    if (endpoint === '/git/commits' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { tree: string; parents: string[]; message: string };
      const sha = `commit-${counts.commits + 1}`;
      counts.commits += 1;
      commits.set(sha, { treeSha: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    if (endpoint === '/git/refs/heads/main' && method === 'PATCH') {
      counts.patch += 1;
      const body = JSON.parse(String(init?.body)) as { sha: string; force: unknown };
      forceValues.push(body.force);
      if (advanceBeforePatch) {
        advanceBeforePatch = false;
        const parent = refs.get('main') as string;
        const oldCommit = commits.get(parent) as { treeSha: string };
        const sha = 'commit-external';
        commits.set(sha, { treeSha: oldCommit.treeSha, parents: [parent], message: 'external' });
        refs.set('main', sha);
        return json({ message: 'Update is not a fast forward' }, 422);
      }
      const commit = commits.get(body.sha);
      if (!commit || !commit.parents.includes(refs.get('main') as string)) {
        return json({ message: 'Update is not a fast forward' }, 422);
      }
      refs.set('main', body.sha);
      if (loseFirstPatchResponse) {
        loseFirstPatchResponse = false;
        throw new TypeError('simulated lost response after accepted ref update');
      }
      return json({ ref: 'refs/heads/main', object: { sha: body.sha } });
    }
    return json({ message: `Unhandled ${method} ${endpoint}` }, 500);
  };

  return {
    fetch,
    refs,
    commits,
    trees,
    counts,
    forceValues: () => forceValues,
    requests,
    addFileToTree: (treeSha: string, filePath: string, bytes: Uint8Array) => {
      const sha = gitBlobSha(bytes);
      blobs.set(sha, new Uint8Array(bytes));
      trees.get(treeSha)?.set(filePath, sha);
    },
    advance: () => { advanceBeforePatch = true; },
    losePatchResponse: () => { loseFirstPatchResponse = true; },
  };
}

function clientFor(fake: ReturnType<typeof createFakeGitHub>): GitHubRestClient {
  return new GitHubRestClient({
    repositories,
    tokenProvider: { getToken: async () => 'fake-token' },
    fetch: fake.fetch,
  });
}

describe('private GitHub v1 backup', () => {
  it('round-trips Chinese Markdown with CRLF and omitted optional fields byte-for-byte', () => {
    const original = article('article-1', '---\r\ntitle: 中文\r\ntags:\r\n  - 测试\r\n---\r\n\r\n正文\r\n');
    const encoded = encodeBackupSnapshot(backupInput({ articles: [original] }));
    const directory = createHash('sha256').update(original.id).digest('hex');
    const decoded = decodeBackupArticle(
      encoded.files.get(`articles/${directory}/metadata.json`) as Uint8Array,
      encoded.files.get(`articles/${directory}/content.md`) as Uint8Array,
    );

    expect(decoded).toEqual(original);
    expect(Buffer.from(encoded.files.get(`articles/${directory}/content.md`) as Uint8Array)).toEqual(Buffer.from(original.content, 'utf8'));
  });

  it('content-addresses media bytes and reuses paths only for identical bytes', () => {
    const firstBytes = new Uint8Array([0, 255, 17, 128]);
    const secondBytes = new Uint8Array([0, 255, 17, 129]);
    const mediaManifest = {
      version: 1 as const,
      updatedAt: '2026-09-30T00:00:00.000Z',
      assets: [
        { id: createHash('sha256').update(firstBytes).digest('hex'), path: 'files/one.png', publicPath: '/media/files/one.png', mimeType: 'image/png' as const, size: 4, hash: createHash('sha256').update(firstBytes).digest('hex'), createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' },
        { id: createHash('sha256').update(firstBytes).digest('hex'), path: 'files/copy.png', publicPath: '/media/files/copy.png', mimeType: 'image/png' as const, size: 4, hash: createHash('sha256').update(firstBytes).digest('hex'), createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' },
        { id: createHash('sha256').update(secondBytes).digest('hex'), path: 'files/changed.png', publicPath: '/media/files/changed.png', mimeType: 'image/png' as const, size: 4, hash: createHash('sha256').update(secondBytes).digest('hex'), createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' },
      ],
    };
    const encoded = encodeBackupSnapshot(backupInput({
      mediaManifest,
      mediaObjects: [
        { assetPath: 'files/one.png', bytes: firstBytes },
        { assetPath: 'files/copy.png', bytes: firstBytes },
        { assetPath: 'files/changed.png', bytes: secondBytes },
      ],
    }));
    const firstPath = `media/objects/${createHash('sha256').update(firstBytes).digest('hex')}.png`;
    const changedPath = `media/objects/${createHash('sha256').update(secondBytes).digest('hex')}.png`;

    expect(encoded.files.get(firstPath)).toEqual(firstBytes);
    expect(encoded.files.get(changedPath)).toEqual(secondBytes);
    expect([...encoded.files.keys()].filter((filePath) => filePath === firstPath)).toHaveLength(1);
    expect(changedPath).not.toBe(firstPath);
  });

  it('rejects unknown fields and future schemas before making any remote request', async () => {
    const fake = createFakeGitHub();
    const client = clientFor(fake);
    const invalidInputs = [
      backupInput({ articles: [article('article-1', 'body', { unexpected: 'secret' })] }),
      backupInput({ schemaVersion: 99 } as Partial<BackupSnapshotInput>),
    ];

    for (const input of invalidInputs) {
      await expect(writeGitHubBackup(client, input)).rejects.toThrow(/UNSUPPORTED_SCHEMA/i);
    }
    expect(fake.counts.writes).toBe(0);
    expect(fake.counts.patch).toBe(0);
    expect(() => decodeBackupArticle(
      Buffer.from(JSON.stringify({ schemaVersion: 2, id: 'x' })),
      Buffer.from('body'),
    )).toThrow(/UNSUPPORTED_SCHEMA/i);
  });

  it('refuses a public backup repository before any Git write', async () => {
    const fake = createFakeGitHub({ privateRepository: false });

    await expect(writeGitHubBackup(clientFor(fake), backupInput())).rejects.toThrow(/private/i);

    expect(fake.requests.some((request) => ['POST', 'PATCH'].includes(request.method))).toBe(false);
  });

  it('re-reads and recomputes after a non-fast-forward without force-updating', async () => {
    const fake = createFakeGitHub();
    fake.advance();

    const proof = await writeGitHubBackup(clientFor(fake), backupInput());

    expect(fake.counts.patch).toBe(2);
    expect(fake.forceValues()).toEqual([false, false]);
    expect(fake.refs.get('main')).toBe(proof.commitSha);
    expect(fake.commits.get(proof.commitSha)?.parents).toEqual(['commit-external']);
  });

  it('finds the committed snapshot after a successful ref update loses its response', async () => {
    const fake = createFakeGitHub();
    fake.losePatchResponse();

    const proof = await writeGitHubBackup(clientFor(fake), backupInput());

    expect(fake.counts.commits).toBe(1);
    expect(fake.refs.get('main')).toBe(proof.commitSha);
    expect(proof.snapshotId).toBe('snapshot-fixed-1');
  });

  it('preserves and re-verifies only unchanged repository blobs', async () => {
    const fake = createFakeGitHub();
    const firstClient = clientFor(fake);
    const firstProof = await writeGitHubBackup(firstClient, backupInput());
    const readsAfterFirstWrite = fake.counts.blobReads;
    const blobWritesAfterFirstWrite = fake.counts.writes;

    const secondProof = await writeGitHubBackup(firstClient, backupInput({
      snapshotId: 'snapshot-fixed-2',
      reason: 'second snapshot',
    }));

    expect(secondProof.commitSha).not.toBe(firstProof.commitSha);
    expect(fake.counts.blobReads).toBeGreaterThan(readsAfterFirstWrite);
    expect(fake.counts.writes - blobWritesAfterFirstWrite).toBe(1);
  });

  it('removes stale snapshot-owned paths while preserving unrelated repository files', async () => {
    const fake = createFakeGitHub();
    const firstClient = clientFor(fake);
    const initial = backupInput({ articles: [article('old-article', 'old')] });
    const firstProof = await writeGitHubBackup(firstClient, initial);
    const initialCommit = fake.commits.get(firstProof.commitSha) as { treeSha: string };
    fake.addFileToTree(initialCommit.treeSha, 'manual-notes.txt', new TextEncoder().encode('keep'));

    const secondProof = await writeGitHubBackup(firstClient, backupInput({
      snapshotId: 'snapshot-with-removed-article',
      articles: [],
    }));
    const secondCommit = fake.commits.get(secondProof.commitSha) as { treeSha: string };
    const finalPaths = [...(fake.trees.get(secondCommit.treeSha) as Map<string, string>).keys()];
    const oldArticlePath = `articles/${createHash('sha256').update('old-article').digest('hex')}/metadata.json`;

    expect(finalPaths).toContain('manual-notes.txt');
    expect(finalPaths).not.toContain(oldArticlePath);
  });

  it('writes the complete v1 layout and persists a proof only after read-back verification', async () => {
    const fake = createFakeGitHub();
    let persistedProof: unknown = null;
    const input = backupInput({
      publication: {
        live: null,
        liveSnapshot: siteSnapshot([]),
        candidate: {
          snapshot: siteSnapshot([article('candidate', 'candidate body')]),
          candidateDigest: computeCandidateDigest(siteSnapshot([article('candidate', 'candidate body')])),
        },
      },
    });

    const proof = await writeGitHubBackup(clientFor(fake), input, {
      persistProof: async (value) => { persistedProof = value; },
    });

    expect(persistedProof).toEqual(proof);
    expect(proof).toEqual(expect.objectContaining({ repository: 'owner/backup', commitSha: expect.any(String), snapshotId: input.snapshotId, contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/), candidateDigest: computeCandidateDigest(input.publication.candidate!.snapshot), verifiedAt: expect.any(String) }));
    const commit = fake.commits.get(proof.commitSha);
    expect(commit).toBeDefined();
    const tree = fake.commits.get(proof.commitSha) as { treeSha: string };
    expect([...((fake as unknown as { trees: Map<string, Map<string, string>> }).trees.get(tree.treeSha) ?? new Map()).keys()]).toEqual(expect.arrayContaining([
      'snapshot.json',
      `articles/${createHash('sha256').update('article-1').digest('hex')}/metadata.json`,
      'navigation/tools.json',
      'navigation/identities.json',
      'settings/site.json',
      'media/manifest.json',
      'publication/live.json',
      'publication/live-snapshot.json',
      'publication/candidate.json',
    ]));
  });
});
