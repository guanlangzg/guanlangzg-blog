import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Article } from '@/app/types/article';
import { decodeBackupArticle } from '@/lib/github/backup-decode';
import type { GitHubTokenProvider } from '@/lib/github/app';
import type { GitHubRepositoryReference } from '@/lib/github/config';
import {
  getEditorDataResourceManifest,
  readArticlesFromDisk,
  writeArticlesToDiskIfRevisionMatches,
  type EditorDataResourceWriteResult,
} from '@/lib/editor-data-storage';
import {
  isSafeMediaRelativePath,
  readEditorMediaFile,
  readEditorMediaManifest,
  type EditorMediaManifest,
} from '@/lib/editor-media-storage';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { validateArticlePaths } from '@/lib/publishing/snapshot';
import { createCurrentEditorBackupPayload } from '@/lib/editor-data-backup';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { sha256Hex, stableJsonStringify } from '@/lib/stable-json';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ArticleHistoryCommit {
  sha: string;
  message: string;
  committedAt: string;
}

export interface ArticleHistoryPageResult {
  commits: ArticleHistoryCommit[];
  nextPage: number | null;
}

export interface ArticleHistoryApi {
  listCommits(path: string, page: number, perPage: number): Promise<ArticleHistoryPageResult>;
  readFile(path: string, commitSha: string): Promise<Uint8Array>;
}

export interface ArticleHistorySummary {
  title: string;
  slug: string | null;
  updatedAt: number;
  content: string;
  contentDigest: string;
  metadataDigest: string;
}

export interface ArticleHistoryVersion {
  commitSha: string;
  message: string;
  committedAt: string;
  article: Article;
  summary: ArticleHistorySummary;
}

export interface ArticleHistoryPage {
  articleId: string;
  page: number;
  perPage: number;
  nextPage: number | null;
  versions: ArticleHistoryVersion[];
}

export interface ArticleHistoryRestoreActions {
  currentArticles: () => Promise<Article[]> | Article[];
  protectDraft: (articles: Article[]) => Promise<void> | void;
  writeDrafts: (articles: Article[]) => Promise<boolean | void> | boolean | void;
  mediaManifest: () => Promise<EditorMediaManifest> | EditorMediaManifest;
  validateManagedMedia: (article: Article, manifest: EditorMediaManifest) => Promise<void> | void;
  now?: () => Date;
}

export interface RestoreArticleHistoryInput {
  articleId: string;
  commitSha: string;
}

export class ArticleHistoryConflictError extends Error {
  constructor() {
    super('Current drafts changed during history restore; refresh and retry.');
    this.name = 'ArticleHistoryConflictError';
  }
}

function articleDirectory(articleId: string): string {
  if (!articleId || articleId.trim() !== articleId) throw new Error('Article ID is invalid.');
  return `articles/${sha256Hex(articleId)}`;
}

function createSummary(article: Article): ArticleHistorySummary {
  const { content, ...metadata } = article;
  return {
    title: article.title,
    slug: article.slug ?? null,
    updatedAt: article.updatedAt,
    content,
    contentDigest: sha256Hex(content),
    metadataDigest: sha256Hex(stableJsonStringify(metadata)),
  };
}

async function readHistoryVersion(api: ArticleHistoryApi, articleId: string, commit: ArticleHistoryCommit): Promise<ArticleHistoryVersion> {
  const directory = articleDirectory(articleId);
  const [metadata, content] = await Promise.all([
    api.readFile(`${directory}/metadata.json`, commit.sha),
    api.readFile(`${directory}/content.md`, commit.sha),
  ]);
  const article = decodeBackupArticle(metadata, content);
  if (article.id !== articleId) throw new Error('History article ID does not match its stable directory.');
  return {
    commitSha: commit.sha,
    message: commit.message,
    committedAt: commit.committedAt,
    article,
    summary: createSummary(article),
  };
}

export async function listArticleHistory(
  api: ArticleHistoryApi,
  articleId: string,
  options: { page?: number; perPage?: number } = {},
): Promise<ArticleHistoryPage> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('History page must be a positive integer.');
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_PAGE_SIZE) throw new Error(`History page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  const result = await api.listCommits(articleDirectory(articleId), page, perPage);
  const versions = await Promise.all(result.commits.map((commit) => readHistoryVersion(api, articleId, commit)));
  return { articleId, page, perPage, nextPage: result.nextPage, versions };
}

function collectManagedMediaPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') {
    const expression = /(?:https?:\/\/[^\s"'<>)]*)?\/media\/(files\/[^\s"'<>()[\]]+)/g;
    for (const match of value.matchAll(expression)) {
      const mediaPath = (match[1] ?? '').replace(/[.,;]+$/, '');
      if (mediaPath) paths.add(mediaPath);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectManagedMediaPaths(item, paths));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectManagedMediaPaths(item, paths));
  }
}

async function validateLocalManagedMedia(article: Article, manifest: EditorMediaManifest): Promise<void> {
  const referencedPaths = new Set<string>();
  collectManagedMediaPaths(article, referencedPaths);
  const assets = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  for (const mediaPath of referencedPaths) {
    if (!isSafeMediaRelativePath(mediaPath)) throw new Error(`Managed media reference is unsafe: ${mediaPath}`);
    const asset = assets.get(mediaPath);
    if (!asset) throw new Error(`Managed media reference is missing: ${mediaPath}`);
    const bytes = await readEditorMediaFile(asset);
    if (!bytes || bytes.byteLength !== asset.size || sha256Hex(bytes) !== asset.hash) {
      throw new Error(`Managed media bytes are missing or invalid: ${mediaPath}`);
    }
  }
}

async function createProtectedDraftCopy(articles: Article[]): Promise<void> {
  const payload = await createCurrentEditorBackupPayload({ includeInlineMediaFiles: true });
  const directory = path.join(getRuntimeDataRootPath(), 'workflow', 'recovery', `article-history-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path.join(directory, 'protected-current.json'), {
    version: 1,
    articleIds: articles.map((article) => article.id),
    payload,
    protectedAt: new Date().toISOString(),
  }, { mode: 0o600 });
}

async function readCurrentArticles(): Promise<Article[]> {
  return readArticlesFromDisk();
}

async function protectCurrentDrafts(articles: Article[]): Promise<void> {
  await createProtectedDraftCopy(articles);
}

async function writeRestoredDrafts(articles: Article[], expectedRevision: string | null): Promise<void> {
  const result: EditorDataResourceWriteResult<Article[]> = await writeArticlesToDiskIfRevisionMatches(articles, expectedRevision);
  if (!result.success) throw new ArticleHistoryConflictError();
}

const defaultRestoreActions: Pick<ArticleHistoryRestoreActions, 'currentArticles' | 'protectDraft' | 'mediaManifest' | 'validateManagedMedia'> = {
  currentArticles: readCurrentArticles,
  protectDraft: protectCurrentDrafts,
  mediaManifest: readEditorMediaManifest,
  validateManagedMedia: validateLocalManagedMedia,
};

export async function restoreArticleHistoryVersion(
  api: ArticleHistoryApi,
  input: RestoreArticleHistoryInput,
  actions: Partial<ArticleHistoryRestoreActions> = {},
): Promise<Article> {
  const version = await readHistoryVersion(api, input.articleId, {
    sha: input.commitSha,
    message: 'History restore',
    committedAt: '',
  });
  const currentArticles = await (actions.currentArticles ?? defaultRestoreActions.currentArticles)();
  const existing = currentArticles.find((article) => article.id === input.articleId);
  const now = (actions.now ?? (() => new Date()))();
  const restored: Article = {
    ...version.article,
    id: input.articleId,
    createdAt: existing?.createdAt ?? version.article.createdAt,
    updatedAt: now.getTime(),
    status: 'draft',
  };
  const nextArticles = existing
    ? currentArticles.map((article) => article.id === input.articleId ? restored : article)
    : [...currentArticles, restored];
  validateArticlePaths(nextArticles);
  const mediaManifest = await (actions.mediaManifest ?? defaultRestoreActions.mediaManifest)();
  await (actions.validateManagedMedia ?? defaultRestoreActions.validateManagedMedia)(restored, mediaManifest);
  await (actions.protectDraft ?? defaultRestoreActions.protectDraft)(currentArticles);

  if (actions.writeDrafts) {
    const result = await actions.writeDrafts(nextArticles);
    if (result === false) throw new ArticleHistoryConflictError();
  } else {
    const currentManifest = getEditorDataResourceManifest('articles', currentArticles);
    await writeRestoredDrafts(nextArticles, currentManifest?.revision ?? null);
  }
  return restored;
}

interface GitHubHistoryOptions {
  repository: GitHubRepositoryReference;
  tokenProvider: GitHubTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface GitHubCommitItem {
  sha?: unknown;
  commit?: {
    message?: unknown;
    author?: { date?: unknown } | null;
    committer?: { date?: unknown } | null;
  };
}

function parseLinkNextPage(header: string | null): number | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (!match || match[2] !== 'next') continue;
    const url = new URL(match[1]);
    const page = Number(url.searchParams.get('page'));
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  }
  return null;
}

function githubPath(repository: GitHubRepositoryReference, pathValue: string): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${pathValue}`;
}

async function requestGitHubHistory(
  options: GitHubHistoryOptions,
  endpoint: string,
): Promise<Response> {
  const token = await options.tokenProvider.getToken('backup');
  const response = await (options.fetch ?? fetch)(`${GITHUB_API_BASE_URL}${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    const error = new Error(`GitHub article history request failed (HTTP ${response.status}).`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return response;
}

export function createGitHubArticleHistoryApi(options: GitHubHistoryOptions): ArticleHistoryApi {
  return {
    async listCommits(articlePath, page, perPage) {
      const query = new URLSearchParams({ path: articlePath, page: String(page), per_page: String(perPage) });
      const response = await requestGitHubHistory(options, `${githubPath(options.repository, 'commits')}?${query}`);
      const payload = await response.json() as unknown;
      if (!Array.isArray(payload)) throw new Error('GitHub article commit list response is invalid.');
      const commits = payload.map((value): ArticleHistoryCommit => {
        const item = value as GitHubCommitItem;
        const authorDate = item.commit?.author?.date ?? item.commit?.committer?.date;
        if (typeof item.sha !== 'string' || typeof item.commit?.message !== 'string' || typeof authorDate !== 'string') {
          throw new Error('GitHub article commit entry is invalid.');
        }
        return { sha: item.sha, message: item.commit.message, committedAt: authorDate };
      });
      return { commits, nextPage: parseLinkNextPage(response.headers.get('Link')) };
    },
    async readFile(filePath, commitSha) {
      const encodedPath = filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const query = new URLSearchParams({ ref: commitSha });
      const response = await requestGitHubHistory(options, `${githubPath(options.repository, `contents/${encodedPath}`)}?${query}`);
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('GitHub historical file response is invalid.');
      const record = payload as Record<string, unknown>;
      if (record.encoding !== 'base64' || typeof record.content !== 'string') throw new Error('GitHub historical file encoding is unsupported.');
      return new Uint8Array(Buffer.from(record.content.replace(/\n/g, ''), 'base64'));
    },
  };
}
