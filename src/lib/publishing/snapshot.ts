import { sha256Hex, stableJsonStringify } from '@/lib/stable-json';
import type { Article } from '@/app/types/article';
import type { MediaRef, PublishScope, SiteSnapshot } from '@/lib/publishing/types';

const RESERVED_SLUGS = new Set([
  'api',
  '_next',
  'blog',
  'editor',
  'feed.xml',
  'favicon.ico',
  'media',
  'navigation',
  'og',
  'robots.txt',
  'search',
  'setup',
  'sitemap.xml',
]);

export class PublishingSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishingSnapshotError';
  }
}

function cloneSnapshot(snapshot: SiteSnapshot): SiteSnapshot {
  return structuredClone(snapshot);
}

function articlePath(article: Article): string {
  return `/posts/${encodeURIComponent(article.slug ?? article.id)}/`;
}

function validateSlug(slug: string, articleId: string): void {
  if (!slug || slug === '.' || slug === '..') {
    throw new PublishingSnapshotError(`Article slug is invalid: ${articleId}`);
  }

  let decoded = slug;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (decoded.includes('/') || decoded.includes('\\')) {
      throw new PublishingSnapshotError(`Article slug contains a path separator: ${articleId}`);
    }

    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new PublishingSnapshotError(`Article slug contains invalid URL encoding: ${articleId}`);
    }
  }

  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new PublishingSnapshotError(`Article slug contains an encoded path separator: ${articleId}`);
  }

  if (RESERVED_SLUGS.has(decoded.toLocaleLowerCase('en-US'))) {
    throw new PublishingSnapshotError(`Article slug is reserved: ${articleId}`);
  }
}

export function validateArticlePaths(articles: Article[]): void {
  const ids = new Set<string>();
  const slugs = new Set<string>();

  for (const article of articles) {
    if (ids.has(article.id)) {
      throw new PublishingSnapshotError(`Duplicate article id: ${article.id}`);
    }
    ids.add(article.id);

    const slug = article.slug ?? article.id;
    validateSlug(slug, article.id);
    const normalizedSlug = slug.toLocaleLowerCase('en-US');

    if (slugs.has(normalizedSlug)) {
      throw new PublishingSnapshotError(`Duplicate article slug: ${slug}`);
    }
    slugs.add(normalizedSlug);
  }
}

function collectManagedMediaPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') {
    const expression = /(?:https?:\/\/[^\s"'<>)]*)?\/media\/(files\/[^\s"'<>()[\]]+)/g;

    for (const match of value.matchAll(expression)) {
      const path = match[1].replace(/[.,;]+$/, '');
      if (path) paths.add(path);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectManagedMediaPaths(item, paths);
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectManagedMediaPaths(item, paths);
    }
  }
}

function selectMedia(snapshot: SiteSnapshot, base: SiteSnapshot, draft: SiteSnapshot): MediaRef[] {
  const referencedPaths = new Set<string>();
  collectManagedMediaPaths(snapshot.articles, referencedPaths);
  collectManagedMediaPaths(snapshot.navigation, referencedPaths);
  collectManagedMediaPaths(snapshot.settings, referencedPaths);

  const available = new Map<string, MediaRef>();

  for (const media of [...base.media, ...draft.media]) {
    const existing = available.get(media.originalPath);
    if (existing && (existing.sha256 !== media.sha256 || existing.size !== media.size)) {
      throw new PublishingSnapshotError(`Managed media path has conflicting bytes: ${media.originalPath}`);
    }
    available.set(media.originalPath, media);
  }

  return [...referencedPaths].sort().map((mediaPath) => {
    const reference = available.get(mediaPath);
    if (!reference) {
      throw new PublishingSnapshotError(`Referenced managed media is missing: ${mediaPath}`);
    }
    return structuredClone(reference);
  });
}

function appendRedirect(
  redirects: SiteSnapshot['redirects'],
  from: string,
  to: string,
): SiteSnapshot['redirects'] {
  if (from === to) return redirects;
  const existing = redirects.findIndex((redirect) => redirect.from === from);
  if (existing >= 0) {
    return redirects.map((redirect, index) => index === existing ? { from, to } : redirect);
  }
  return [...redirects, { from, to }];
}

function addRemovedPath(paths: string[], article: Article): string[] {
  const removedPath = articlePath(article);
  return paths.includes(removedPath) ? paths : [...paths, removedPath];
}

function mergeBootstrapArticles(base: Article[], selected: Article[]): Article[] {
  const selectedById = new Map(selected.map((article) => [article.id, article]));
  const merged = base.map((article) => selectedById.get(article.id) ?? article);
  const baseIds = new Set(base.map((article) => article.id));
  return [...merged, ...selected.filter((article) => !baseIds.has(article.id))];
}

function selectDraftArticles(draft: SiteSnapshot, articleIds: string[]): Article[] {
  const requestedIds = new Set(articleIds);
  const selected = draft.articles.filter((article) => requestedIds.has(article.id));

  if (selected.length !== requestedIds.size) {
    const foundIds = new Set(selected.map((article) => article.id));
    const missing = [...requestedIds].filter((id) => !foundIds.has(id));
    throw new PublishingSnapshotError(`Bootstrap articles are missing: ${missing.join(', ')}`);
  }

  return selected;
}

function applyScope(base: SiteSnapshot, draft: SiteSnapshot, scope: PublishScope): SiteSnapshot {
  const candidate = cloneSnapshot(base);

  if (scope.kind === 'article' && scope.action === 'publish') {
    const nextArticle = draft.articles.find((article) => article.id === scope.articleId);
    if (!nextArticle) {
      throw new PublishingSnapshotError(`Draft article not found: ${scope.articleId}`);
    }

    const previous = candidate.articles.find((article) => article.id === scope.articleId);
    if (previous && previous.slug !== nextArticle.slug) {
      candidate.redirects = appendRedirect(
        candidate.redirects,
        articlePath(previous),
        articlePath(nextArticle),
      );
    }
    candidate.articles = previous
      ? candidate.articles.map((article) => article.id === scope.articleId ? structuredClone(nextArticle) : article)
      : [...candidate.articles, structuredClone(nextArticle)];
  } else if (scope.kind === 'article' && scope.action === 'withdraw') {
    const previous = candidate.articles.find((article) => article.id === scope.articleId);
    candidate.articles = candidate.articles.filter((article) => article.id !== scope.articleId);
    if (previous) candidate.removedPaths = addRemovedPath(candidate.removedPaths, previous);
  } else if (scope.kind === 'navigation') {
    candidate.navigation = structuredClone(draft.navigation);
  } else if (scope.kind === 'settings') {
    candidate.settings = structuredClone(draft.settings);
  } else if (scope.kind === 'bootstrap') {
    const selected = selectDraftArticles(draft, scope.articleIds);
    candidate.articles = mergeBootstrapArticles(candidate.articles, selected);
    candidate.navigation = structuredClone(draft.navigation);
    candidate.settings = structuredClone(draft.settings);
  } else {
    throw new PublishingSnapshotError('Unsupported publish scope');
  }

  return candidate;
}

export function createCandidate(
  base: SiteSnapshot,
  draft: SiteSnapshot,
  scope: PublishScope,
): SiteSnapshot {
  const candidate = applyScope(base, draft, scope);
  validateArticlePaths(candidate.articles);
  candidate.media = selectMedia(candidate, base, draft);
  return candidate;
}

function canonicalMedia(media: MediaRef[]): MediaRef[] {
  return [...media]
    .map((item) => ({
      originalPath: item.originalPath,
      publicPath: item.publicPath,
      sha256: item.sha256.toLowerCase(),
      size: item.size,
      mimeType: item.mimeType,
    }))
    .sort((left, right) => left.originalPath.localeCompare(right.originalPath));
}

export function computeCandidateDigest(snapshot: SiteSnapshot): string {
  const content = {
    schemaVersion: snapshot.schemaVersion,
    siteId: snapshot.siteId,
    articles: snapshot.articles,
    navigation: snapshot.navigation,
    settings: snapshot.settings,
    media: canonicalMedia(snapshot.media),
    redirects: snapshot.redirects,
    removedPaths: snapshot.removedPaths,
  };
  return sha256Hex(stableJsonStringify(content));
}

export function computeSelectedRevision(input: {
  scope: PublishScope;
  generation: string;
  selectedInputs: unknown;
  media: MediaRef[];
}): string {
  const revision = {
    schemaVersion: 1,
    scope: input.scope,
    generation: input.generation,
    selectedInputs: input.selectedInputs,
    media: canonicalMedia(input.media),
  };
  return sha256Hex(stableJsonStringify(revision));
}
