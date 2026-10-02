import { randomUUID } from 'node:crypto';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { isRecord } from '@/lib/article-data';
import { parseNavigationDataOrThrow } from '@/lib/navigation-data';
import { parseSiteSettingsOrThrow } from '@/lib/site-settings';
import type { GitHubRepositoryInfo } from '@/lib/github/client';
import { GitHubApiError, GitHubRestClient } from '@/lib/github/client';
import { assertSupportedBackupSchema, decodeBackupArticle } from '@/lib/github/backup-decode';
import type { NavigationIdentityMap } from '@/lib/navigation-identities';
import type { BackupProof, LivePointer, SiteSnapshot } from '@/lib/publishing/types';
import type { SiteSettings } from '@/lib/site-settings';
import { sha256Hex, stableJsonStringify } from '@/lib/stable-json';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import type { EditorMediaManifest, EditorMediaAsset } from '@/lib/editor-media-storage';
import type { JobRecord } from '@/lib/jobs/store';

export interface BackupSnapshotInput {
  snapshotId: string;
  siteId: string;
  articles: Article[];
  navigation: Category[];
  navigationIdentities: NavigationIdentityMap;
  settings: SiteSettings;
  mediaManifest: EditorMediaManifest;
  mediaObjects: Array<{ assetPath: string; bytes: Uint8Array }>;
  publication: {
    live: LivePointer | null;
    liveSnapshot: SiteSnapshot | null;
    candidate: { snapshot: SiteSnapshot; candidateDigest: string } | null;
  };
  schemaVersion?: number;
  reason?: string;
  contentSequence?: number;
  generation?: string;
}

export interface EncodedBackupSnapshot {
  manifest: BackupSnapshotManifest;
  files: Map<string, Uint8Array>;
  contentDigest: string;
  candidateDigest: string;
}

export interface BackupSnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  siteId: string;
  reason: string;
  contentSequence: number | null;
  generation: string | null;
  contentDigest: string;
  candidateDigest: string;
  files: Record<string, { size: number; sha256: string }>;
}

interface TreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

type TreeMutation = { path: string; mode: '100644'; type: 'blob'; sha: string | null };


interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  commit: { message?: string; author?: { date?: string } };
}

export interface BackupWriteOptions {
  branch?: string;
  maxAttempts?: number;
  now?: () => Date;
  persistProof?: (proof: BackupProof) => Promise<void> | void;
  enqueueJob?: (input: { type: 'backup'; input: unknown }) => Promise<JobRecord>;
}

const MAX_TREE_ENTRIES = 10_000;
const MAX_NON_FAST_FORWARD_RETRIES = 3;
const ARTICLE_FIELDS = new Set([
  'id', 'slug', 'title', 'date', 'description', 'tags', 'content', 'createdAt', 'updatedAt',
  'kind', 'status', 'category', 'series', 'featured', 'updatedDate', 'sourceLinks', 'revisionNotes', 'templateId',
]);
const CATEGORY_FIELDS = new Set(['name', 'icon', 'slug', 'tools']);
const TOOL_FIELDS = new Set(['icon', 'title', 'description', 'url', 'tags']);
const MEDIA_ASSET_FIELDS = new Set(['id', 'path', 'publicPath', 'mimeType', 'size', 'hash', 'createdAt', 'updatedAt']);
const LIVE_POINTER_FIELDS = new Set(['schemaVersion', 'releaseId', 'candidateDigest', 'artifactDigest', 'publicCommitSha', 'workflowRunId', 'workflowRunAttempt', 'verifiedAt']);
const SNAPSHOT_FIELDS = new Set(['schemaVersion', 'siteId', 'articles', 'navigation', 'settings', 'media', 'redirects', 'removedPaths']);
const SETTINGS_FIELDS = new Set([
  'siteName', 'siteDescription', 'workspaceLabel', 'heroTitleLineOne', 'heroTitleLineTwo', 'heroDescription',
  'showIntroCard', 'introCardEyebrow', 'introCardTitle', 'introCardDescription', 'introCardMetaOneLabel',
  'introCardMetaOneValue', 'introCardMetaTwoLabel', 'introCardMetaTwoValue', 'introCardMetaThreeLabel',
  'introCardMetaThreeValue', 'introCardStartLabel',
]);

function assertExactKeys(value: unknown, allowed: Set<string>, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`UNSUPPORTED_SCHEMA: ${label} contains unsupported field(s): ${unknown.join(', ')}`);
}

function assertNoUnknownArticleFields(value: unknown, label = 'Article'): asserts value is Article {
  assertExactKeys(value, ARTICLE_FIELDS, label);
  for (const [field, nestedAllowed] of [['sourceLinks', new Set(['title', 'url', 'note'])], ['revisionNotes', new Set(['date', 'note'])]] as const) {
    const nested = value[field];
    if (nested === undefined) continue;
    if (!Array.isArray(nested)) throw new Error(`${label}.${field} must be an array.`);
    nested.forEach((item, index) => assertExactKeys(item, nestedAllowed, `${label}.${field}[${index}]`));
  }
}

function assertSnapshot(value: SiteSnapshot, label: string): void {
  assertSupportedBackupSchema(value, label);
  assertExactKeys(value, SNAPSHOT_FIELDS, label);
  if (!Array.isArray(value.articles)) throw new Error(`${label}.articles must be an array.`);
  value.articles.forEach((article, index) => assertNoUnknownArticleFields(article, `${label}.articles[${index}]`));
  if (!Array.isArray(value.navigation)) throw new Error(`${label}.navigation must be an array.`);
  value.navigation.forEach((category, categoryIndex) => {
    assertExactKeys(category, CATEGORY_FIELDS, `${label}.navigation[${categoryIndex}]`);
    if (!Array.isArray(category.tools)) throw new Error(`${label}.navigation[${categoryIndex}].tools must be an array.`);
    category.tools.forEach((tool, toolIndex) => assertExactKeys(tool, TOOL_FIELDS, `${label}.navigation[${categoryIndex}].tools[${toolIndex}]`));
  });
  assertExactKeys(value.settings, SETTINGS_FIELDS, `${label}.settings`);
  value.media.forEach((media, index) => assertExactKeys(media, new Set(['originalPath', 'publicPath', 'sha256', 'size', 'mimeType']), `${label}.media[${index}]`));
}

function assertInput(input: BackupSnapshotInput): void {
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw new Error(`UNSUPPORTED_SCHEMA: Backup snapshot schemaVersion ${input.schemaVersion} is unsupported.`);
  }
  if (!input.snapshotId || !input.siteId) throw new Error('Backup snapshot ID and site ID are required.');
  input.articles.forEach((article, index) => {
    assertNoUnknownArticleFields(article, `articles[${index}]`);
    decodeBackupArticle(serializeArticle(article).metadata, new TextEncoder().encode(article.content));
  });
  input.navigation.forEach((category, categoryIndex) => {
    assertExactKeys(category, CATEGORY_FIELDS, `navigation[${categoryIndex}]`);
    category.tools.forEach((tool, toolIndex) => assertExactKeys(tool, TOOL_FIELDS, `navigation[${categoryIndex}].tools[${toolIndex}]`));
  });
  parseNavigationDataOrThrow(input.navigation);
  parseSiteSettingsOrThrow(input.settings);
  assertExactKeys(input.settings, SETTINGS_FIELDS, 'settings/site.json');
  assertExactKeys(input.navigationIdentities, new Set(['schemaVersion', 'categories']), 'navigation identities');
  assertSupportedBackupSchema(input.navigationIdentities, 'Navigation identities');
  input.navigationIdentities.categories.forEach((category, index) => {
    assertExactKeys(category, new Set(['id', 'slug', 'tools']), `navigation identities.categories[${index}]`);
    category.tools.forEach((tool, toolIndex) => assertExactKeys(tool, new Set(['id', 'normalizedUrl', 'groupOrder']), `navigation identities.categories[${index}].tools[${toolIndex}]`));
  });
  assertExactKeys(input.mediaManifest, new Set(['version', 'updatedAt', 'assets']), 'media manifest');
  if (input.mediaManifest.version !== 1) throw new Error(`UNSUPPORTED_SCHEMA: Media manifest version ${input.mediaManifest.version} is unsupported.`);
  input.mediaManifest.assets.forEach((asset, index) => assertExactKeys(asset, MEDIA_ASSET_FIELDS, `media manifest.assets[${index}]`));
  if (input.publication.live) assertExactKeys(input.publication.live, LIVE_POINTER_FIELDS, 'publication.live');
  if (input.publication.liveSnapshot) assertSnapshot(input.publication.liveSnapshot, 'publication.liveSnapshot');
  if (input.publication.candidate) {
    assertExactKeys(input.publication.candidate, new Set(['snapshot', 'candidateDigest']), 'publication.candidate');
    assertSnapshot(input.publication.candidate.snapshot, 'publication.candidate.snapshot');
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function serializeArticle(article: Article): { metadata: Uint8Array; content: Uint8Array } {
  const { content, ...metadata } = article;
  return { metadata: jsonBytes({ schemaVersion: 1, ...metadata }), content: new TextEncoder().encode(content) };
}

function mediaExtension(asset: EditorMediaAsset): string {
  const extension = asset.path.split('.').at(-1)?.toLowerCase();
  if (!extension || !/^[a-z0-9]{1,10}$/.test(extension)) throw new Error(`Unsupported managed media extension: ${asset.path}`);
  return extension;
}

function isSnapshotOwnedPath(filePath: string): boolean {
  return filePath === 'snapshot.json' ||
    /^articles\/[a-f0-9]{64}\/(metadata\.json|content\.md)$/.test(filePath) ||
    filePath === 'navigation/tools.json' ||
    filePath === 'navigation/identities.json' ||
    filePath === 'settings/site.json' ||
    filePath === 'media/manifest.json' ||
    /^media\/objects\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(filePath) ||
    ['publication/live.json', 'publication/live-snapshot.json', 'publication/candidate.json'].includes(filePath);
}

function digestFiles(files: Map<string, Uint8Array>): Record<string, { size: number; sha256: string }> {
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, bytes]) => [
    filePath,
    { size: bytes.byteLength, sha256: sha256Hex(bytes) },
  ]));
}

export function encodeBackupSnapshot(input: BackupSnapshotInput): EncodedBackupSnapshot {
  assertInput(input);
  const files = new Map<string, Uint8Array>();
  for (const article of input.articles) {
    const directory = sha256Hex(article.id);
    const encoded = serializeArticle(article);
    files.set(`articles/${directory}/metadata.json`, encoded.metadata);
    files.set(`articles/${directory}/content.md`, encoded.content);
  }
  files.set('navigation/tools.json', jsonBytes(input.navigation));
  files.set('navigation/identities.json', jsonBytes(input.navigationIdentities));
  files.set('settings/site.json', jsonBytes(input.settings));
  files.set('media/manifest.json', jsonBytes(input.mediaManifest));

  const mediaFiles = new Map<string, Uint8Array>();
  const bytesByPath = new Map(input.mediaObjects.map((object) => [object.assetPath, object.bytes]));
  for (const asset of input.mediaManifest.assets) {
    const bytes = bytesByPath.get(asset.path);
    if (!bytes) throw new Error(`Missing media object bytes: ${asset.path}`);
    const digest = sha256Hex(bytes);
    if (digest !== asset.hash || bytes.byteLength !== asset.size) throw new Error(`Managed media bytes do not match manifest: ${asset.path}`);
    const objectPath = `media/objects/${digest}.${mediaExtension(asset)}`;
    const previous = mediaFiles.get(objectPath);
    if (previous && !Buffer.from(previous).equals(Buffer.from(bytes))) throw new Error(`Media content address collision: ${objectPath}`);
    mediaFiles.set(objectPath, new Uint8Array(bytes));
  }
  for (const [filePath, bytes] of mediaFiles) files.set(filePath, bytes);

  files.set('publication/live.json', jsonBytes(input.publication.live));
  files.set('publication/live-snapshot.json', jsonBytes(input.publication.liveSnapshot));
  if (input.publication.candidate) files.set('publication/candidate.json', jsonBytes(input.publication.candidate));

  const candidateDigest = input.publication.candidate
    ? input.publication.candidate.candidateDigest
    : '';
  if (input.publication.candidate && candidateDigest !== computeCandidateDigest(input.publication.candidate.snapshot)) {
    throw new Error('Candidate digest does not match the frozen snapshot.');
  }
  const contentDigest = sha256Hex(stableJsonStringify(digestFiles(files)));
  const manifest: BackupSnapshotManifest = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    siteId: input.siteId,
    reason: input.reason ?? 'content-snapshot',
    contentSequence: input.contentSequence ?? null,
    generation: input.generation ?? null,
    contentDigest,
    candidateDigest,
    files: digestFiles(files),
  };
  files.set('snapshot.json', jsonBytes(manifest));
  return { manifest, files, contentDigest, candidateDigest };
}

function isRecordWithString(value: unknown, key: string): value is Record<string, unknown> & Record<typeof key, string> {
  return isRecord(value) && typeof value[key] === 'string';
}

function parseTree(value: unknown): { sha: string; tree: TreeItem[] } {
  if (!isRecordWithString(value, 'sha') || !Array.isArray(value.tree)) throw new Error('GitHub tree response format is invalid.');
  if (typeof value.truncated === 'boolean' && value.truncated || value.tree.length >= MAX_TREE_ENTRIES) throw new Error('Backup repository tree is too large or truncated.');
  const tree = value.tree.map((entry): TreeItem => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha !== 'string' || typeof entry.mode !== 'string' || typeof entry.type !== 'string') {
      throw new Error('GitHub tree entry format is invalid.');
    }
    return { path: entry.path, sha: entry.sha, mode: entry.mode, type: entry.type };
  });
  return { sha: value.sha, tree };
}

function parseCommit(value: unknown): GitCommitResponse {
  if (!isRecord(value) || typeof value.sha !== 'string' || !isRecordWithString(value.tree, 'sha') || !Array.isArray(value.parents)) {
    throw new Error('GitHub commit response format is invalid.');
  }
  const parents = value.parents.map((parent) => {
    if (!isRecordWithString(parent, 'sha')) throw new Error('GitHub commit parent format is invalid.');
    return { sha: parent.sha };
  });
  const commit = isRecord(value.commit) ? value.commit : {};
  const author = isRecord(commit.author) ? commit.author : {};
  return {
    sha: value.sha,
    tree: { sha: value.tree.sha },
    parents,
    commit: {
      ...(typeof commit.message === 'string' ? { message: commit.message } : {}),
      author: typeof author.date === 'string' ? { date: author.date } : undefined,
    },
  };
}

async function readHead(client: GitHubRestClient, branch: string): Promise<{ sha: string; commit: GitCommitResponse; tree: ReturnType<typeof parseTree> }> {
  const ref = await client.getReference('backup', branch);
  if (!isRecord(ref) || !isRecordWithString(ref.object, 'sha')) throw new Error('GitHub backup branch reference is invalid.');
  const sha = ref.object.sha;
  const commit = parseCommit(await client.getCommit('backup', sha));
  const tree = parseTree(await client.getTree('backup', commit.tree.sha, true));
  return { sha, commit, tree };
}

async function readBlobBytes(client: GitHubRestClient, sha: string): Promise<Uint8Array> {
  const value = await client.getBlob('backup', sha);
  if (!isRecord(value) || value.encoding !== 'base64' || typeof value.content !== 'string') throw new Error('GitHub blob response format is invalid.');
  return new Uint8Array(Buffer.from(value.content.replace(/\n/g, ''), 'base64'));
}

async function findSnapshotCommit(client: GitHubRestClient, headSha: string, snapshotId: string): Promise<string | null> {
  let sha: string | null = headSha;
  let remaining = 100;
  while (sha && remaining > 0) {
    remaining -= 1;
    const commit = parseCommit(await client.getCommit('backup', sha));
    const tree = parseTree(await client.getTree('backup', commit.tree.sha, true));
    const snapshotEntry = tree.tree.find((entry) => entry.path === 'snapshot.json' && entry.type === 'blob');
    if (snapshotEntry) {
      try {
        const manifest = JSON.parse(Buffer.from(await readBlobBytes(client, snapshotEntry.sha)).toString('utf8')) as unknown;
        if (isRecord(manifest) && manifest.snapshotId === snapshotId) return sha;
      } catch {
        // Ignore historical manifests that cannot be parsed; the next ancestor may contain this ID.
      }
    }
    sha = commit.parents[0]?.sha ?? null;
  }
  return null;
}

async function verifySnapshotFiles(
  client: GitHubRestClient,
  head: Awaited<ReturnType<typeof readHead>>,
  encoded: EncodedBackupSnapshot,
  verifiedFiles: Map<string, { size: number; sha256: string }> = new Map(),
): Promise<void> {
  const entries = new Map(head.tree.tree.map((entry) => [entry.path, entry]));
  const manifestEntry = entries.get('snapshot.json');
  if (!manifestEntry) throw new Error('Backup verification failed: snapshot.json is missing.');
  const manifestBytes = await readBlobBytes(client, manifestEntry.sha);
  if (!Buffer.from(manifestBytes).equals(Buffer.from(jsonBytes(encoded.manifest)))) {
    throw new Error('Backup verification failed: snapshot.json bytes differ.');
  }
  for (const [filePath, expected] of encoded.files) {
    const entry = entries.get(filePath);
    if (!entry) throw new Error(`Backup verification failed: ${filePath} is missing.`);
    const actual = await readBlobBytes(client, entry.sha);
    if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`Backup verification failed: ${filePath} bytes differ.`);
  }
  for (const [filePath, expected] of verifiedFiles) {
    if (encoded.files.has(filePath)) continue;
    const entry = entries.get(filePath);
    if (!entry) throw new Error(`Backup verification failed: previously verified ${filePath} is missing.`);
    const actual = await readBlobBytes(client, entry.sha);
    if (actual.byteLength !== expected.size || sha256Hex(actual) !== expected.sha256) {
      throw new Error(`Backup verification failed: previously verified ${filePath} bytes differ.`);
    }
  }
  for (const articlePath of Object.keys(encoded.manifest.files).filter((filePath) => filePath.startsWith('articles/') && filePath.endsWith('/metadata.json'))) {
    const metadata = entries.get(articlePath);
    const contentPath = articlePath.replace('/metadata.json', '/content.md');
    const content = entries.get(contentPath);
    if (!metadata || !content) throw new Error(`Backup verification failed: article pair is incomplete: ${articlePath}`);
    decodeBackupArticle(await readBlobBytes(client, metadata.sha), await readBlobBytes(client, content.sha));
  }
}

function isNonFastForward(error: unknown): boolean {
  return error instanceof GitHubApiError && error.category === 'conflict';
}

export async function writeGitHubBackup(
  client: GitHubRestClient,
  input: BackupSnapshotInput,
  options: BackupWriteOptions = {},
): Promise<BackupProof> {
  const encoded = encodeBackupSnapshot(input);
  const repository = await client.getRepository('backup');
  if (!repository.private) throw new Error('GitHub backup repository must be private.');
  const branch = options.branch ?? repository.defaultBranch;
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? MAX_NON_FAST_FORWARD_RETRIES, 1), 5);
  let lastConflict: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const head = await readHead(client, branch);
    const priorCommit = await findSnapshotCommit(client, head.sha, input.snapshotId);
    if (priorCommit) {
      const priorHead = await readHead(client, branch);
      if (priorHead.sha !== head.sha) continue;
      await verifySnapshotFiles(client, priorHead, encoded);
      const proof = createBackupProof(repository, priorCommit, encoded, options.now?.() ?? new Date());
      await options.persistProof?.(proof);
      return proof;
    }

    const existingEntries = new Map(head.tree.tree.map((entry) => [entry.path, entry]));
    const newTree: TreeMutation[] = [];
    const verifiedFiles = new Map<string, { size: number; sha256: string }>();
    for (const [filePath, bytes] of encoded.files) {
      const existing = existingEntries.get(filePath);
      if (existing) {
        const existingBytes = await readBlobBytes(client, existing.sha);
        if (sha256Hex(existingBytes) === sha256Hex(bytes)) {
          verifiedFiles.set(filePath, { size: existingBytes.byteLength, sha256: sha256Hex(existingBytes) });
          continue;
        }
      }
      const blob = await client.createBlob('backup', Buffer.from(bytes).toString('base64'), 'base64');
      if (!isRecordWithString(blob, 'sha')) throw new Error('GitHub blob creation response is invalid.');
      newTree.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha });
    }

    for (const entry of head.tree.tree) {
      if (verifiedFiles.has(entry.path) || encoded.files.has(entry.path)) continue;
      if (isSnapshotOwnedPath(entry.path)) {
        newTree.push({ path: entry.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const bytes = await readBlobBytes(client, entry.sha);
      verifiedFiles.set(entry.path, { size: bytes.byteLength, sha256: sha256Hex(bytes) });
    }

    const tree = await client.createTree('backup', newTree, head.tree.sha);
    if (!isRecordWithString(tree, 'sha')) throw new Error('GitHub tree creation response is invalid.');
    const commitResponse = await client.createCommit('backup', {
      message: `backup: ${input.reason ?? 'content snapshot'} [snapshotId:${input.snapshotId}]`,
      tree: tree.sha,
      parents: [head.sha],
    });
    if (!isRecordWithString(commitResponse, 'sha')) throw new Error('GitHub commit creation response is invalid.');
    const commitSha = commitResponse.sha;

    try {
      await client.updateReference('backup', branch, commitSha);
    } catch (error) {
      const fresh = await readHead(client, branch);
      const alreadyCommitted = await findSnapshotCommit(client, fresh.sha, input.snapshotId);
      if (alreadyCommitted) {
        const verifiedHead = await readHead(client, branch);
        await verifySnapshotFiles(client, verifiedHead, encoded);
        const proof = createBackupProof(repository, alreadyCommitted, encoded, options.now?.() ?? new Date());
        await options.persistProof?.(proof);
        return proof;
      }
      if (isNonFastForward(error)) {
        lastConflict = error;
        continue;
      }
      if (fresh.sha !== head.sha) {
        lastConflict = error;
        continue;
      }
      throw error;
    }

    const verifiedHead = await readHead(client, branch);
    if (verifiedHead.sha !== commitSha) {
      const alreadyCommitted = await findSnapshotCommit(client, verifiedHead.sha, input.snapshotId);
      if (!alreadyCommitted) throw new Error('Backup verification failed: branch head does not include the new snapshot.');
    }
    await verifySnapshotFiles(client, verifiedHead, encoded, verifiedFiles);
    const proof = createBackupProof(repository, verifiedHead.sha, encoded, options.now?.() ?? new Date());
    await options.persistProof?.(proof);
    return proof;
  }
  throw new Error(`GitHub backup branch changed concurrently beyond ${maxAttempts} attempts.${lastConflict ? ' Re-read and retry the backup.' : ''}`);
}
function createBackupProof(repositoryInfo: GitHubRepositoryInfo, commitSha: string, encoded: EncodedBackupSnapshot, now: Date): BackupProof {
  const repository = repositoryInfo.fullName;
  return {
    repository,
    commitSha,
    snapshotId: encoded.manifest.snapshotId,
    contentDigest: encoded.contentDigest,
    candidateDigest: encoded.candidateDigest || encoded.contentDigest,
    verifiedAt: now.toISOString(),
  };
}

export function createBackupSnapshotId(): string {
  return randomUUID();
}
