import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { createArticleSlug, parseArticlesDataOrThrow } from '@/lib/article-data';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { createEditorBackupPayload } from '@/lib/editor-data-backup';
import {
  readArticlesFromDisk,
  readNavigationFromDisk,
  readSiteSettingsFromDisk,
  restoreEditorDataRootAtomically,
  withEditorDataRootLock,
} from '@/lib/editor-data-storage';
import {
  isSafeMediaRelativePath,
  parseEditorMediaManifest,
  readEditorMediaFile,
  readEditorMediaManifest,
  type EditorMediaAsset,
} from '@/lib/editor-media-storage';
import { readBackupWatermark } from '@/lib/jobs/watermark';
import {
  createNavigationIdentityMap,
  type NavigationIdentityMap,
} from '@/lib/navigation-identities';
import { parseNavigationDataOrThrow } from '@/lib/navigation-data';
import { validateArticlePaths } from '@/lib/publishing/snapshot';
import { readNavigationIdentities, writeNavigationIdentities } from '@/lib/publishing/store';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import {
  DEFAULT_SITE_SETTINGS,
  parseSiteSettingsOrThrow,
  SITE_SETTING_KEYS,
  type SiteSettings,
} from '@/lib/site-settings';
import { stableJsonStringify } from '@/lib/stable-json';
import {
  createRestoreContentDigest,
  createRestorePlan,
  type RestorableEditorData,
  type RestorePlan,
  type RestoreResolution,
} from '@/lib/restoring/plan';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

export type RestoreChoice = { conflictId: string; resolution: RestoreResolution };

export class RestoreApplicationError extends Error {
  constructor(
    public readonly status: 409 | 422 | 423 | 507,
    public readonly code: 'REVISION_CONFLICT' | 'INVALID_SELECTION' | 'INVALID_BACKUP' | 'DATA_LOCK_TIMEOUT' | 'INSUFFICIENT_STORAGE',
    message: string,
  ) {
    super(message);
    this.name = 'RestoreApplicationError';
  }
}

export interface RestoreApplyDependencies {
  readCurrent(): Promise<{ data: RestorableEditorData; revision: string }>;
  readBackup(commit: string): Promise<{ data: RestorableEditorData; commit: string }>;
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
  takeProtectionCopy?(current: RestorableEditorData): Promise<void>;
  stage?(merged: RestorableEditorData): Promise<unknown>;
  validateStage?(staged: unknown): Promise<RestorableEditorData>;
  applyAtomically?(merged: RestorableEditorData): Promise<unknown>;
  persistNavigationIdentities?(data: RestorableEditorData): Promise<void>;
  readBackupState?(): Promise<{ generation: string; backedUpThrough: number; contentSequence: number }>;
}

export interface RestoreApplicationResult {
  data: RestorableEditorData;
  generation: string;
  backupCaughtUp: false;
  transactionResult: unknown;
}

type StagedRestore = { directory: string };
type MarkdownNode = {
  type: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function failInvalidBackup(message: string): never {
  throw new RestoreApplicationError(422, 'INVALID_BACKUP', message);
}

function failInvalidSelection(message: string): never {
  throw new RestoreApplicationError(422, 'INVALID_SELECTION', message);
}

function conflictChoiceMap(plan: RestorePlan, choices: RestoreChoice[]): Map<string, RestoreResolution> {
  const known = new Map(plan.conflicts.map((conflict) => [conflict.conflictId, conflict]));
  const selected = new Map<string, RestoreResolution>();
  for (const choice of choices) {
    const conflict = known.get(choice.conflictId);
    if (!conflict || selected.has(choice.conflictId) || !conflict.resolutions.includes(choice.resolution)) {
      failInvalidSelection(`恢复冲突选择无效：${choice.conflictId}`);
    }
    selected.set(choice.conflictId, choice.resolution);
  }
  const missing = plan.conflicts.filter((conflict) => !selected.has(conflict.conflictId));
  if (missing.length > 0) failInvalidSelection(`尚未选择 ${missing.length} 项恢复冲突。`);
  return selected;
}

function uniqueArticleId(base: string, seed: string, used: Set<string>): string {
  const suffix = sha256(seed).slice(0, 10);
  let candidate = `${base || 'restored'}-restore-${suffix}`;
  let counter = 1;
  while (used.has(candidate)) candidate = `${base || 'restored'}-restore-${suffix}-${counter++}`;
  used.add(candidate);
  return candidate;
}

function uniqueSlug(base: string, suffix: string, used: Set<string>): string {
  let candidate = `${base || 'restored'}-${suffix}`;
  let counter = 1;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${base || 'restored'}-${suffix}-${counter++}`;
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function cloneArticleWithNewIdentity(article: Article, seed: string, ids: Set<string>, slugs: Set<string>): Article {
  const id = uniqueArticleId(article.id, seed, ids);
  const slug = uniqueSlug(article.slug ?? createArticleSlug(article), sha256(seed).slice(0, 8), slugs);
  return { ...article, id, slug };
}

function mergeArticles(
  current: Article[],
  backup: Article[],
  plan: RestorePlan,
  choices: Map<string, RestoreResolution>,
): { articles: Article[]; currentIds: Set<string>; backupIds: Set<string> } {
  const articles = [...current];
  const currentIds = new Set(current.map((item) => item.id));
  const backupIds = new Set<string>();
  const ids = new Set(articles.map((item) => item.id));
  const slugs = new Set(articles.map((item) => (item.slug ?? item.id).toLocaleLowerCase('en-US')));

  for (const item of backup) {
    const indexById = articles.findIndex((currentItem) => currentItem.id === item.id);
    const slugKey = (item.slug ?? item.id).toLocaleLowerCase('en-US');
    const indexBySlug = articles.findIndex((currentItem) => (currentItem.slug ?? currentItem.id).toLocaleLowerCase('en-US') === slugKey);
    const conflict = plan.conflicts.find((entry) =>
      (entry.kind === 'article-id' && entry.subject.articleId === item.id)
      || (entry.kind === 'article-slug' && entry.subject.backupArticleId === item.id)
      || (entry.kind === 'article-legacy-ambiguous' && entry.subject.backupArticleId === item.id),
    );
    if (!conflict) {
      if (indexById < 0 && indexBySlug < 0) {
        articles.push(item);
        ids.add(item.id);
        slugs.add(slugKey);
        backupIds.add(item.id);
      }
      continue;
    }

    const resolution = choices.get(conflict.conflictId);
    if (resolution === 'keep-current') continue;
    if (resolution === 'keep-both') {
      const copy = cloneArticleWithNewIdentity(item, conflict.conflictId, ids, slugs);
      articles.push(copy);
      backupIds.add(copy.id);
      continue;
    }

    const index = indexById >= 0 ? indexById : indexBySlug;
    if (index >= 0) {
      const previous = articles[index];
      currentIds.delete(previous.id);
      ids.delete(previous.id);
      slugs.delete((previous.slug ?? previous.id).toLocaleLowerCase('en-US'));
      articles[index] = item;
    } else {
      articles.push(item);
    }
    ids.add(item.id);
    slugs.add(slugKey);
    backupIds.add(item.id);
  }

  return { articles, currentIds, backupIds };
}

function uniqueNavigationSlug(base: string, seed: string, used: Set<string>): string {
  const suffix = sha256(seed).slice(0, 8);
  let candidate = `${base}-restore-${suffix}`;
  let counter = 1;
  while (used.has(candidate)) candidate = `${base}-restore-${suffix}-${counter++}`;
  used.add(candidate);
  return candidate;
}

function categoryIdentity(identities: NavigationIdentityMap | null, category: Category): string {
  return identities?.categories.find((item) => item.slug === category.slug)?.id ?? `legacy:${category.slug}`;
}

function mergedIdentity(
  category: Category,
  source: NavigationIdentityMap | null,
): NavigationIdentityMap['categories'][number] {
  return source?.categories.find((item) => item.slug === category.slug)
    ?? createNavigationIdentityMap([category]).categories[0]!;
}

function mergeNavigation(
  current: RestorableEditorData,
  backup: RestorableEditorData,
  plan: RestorePlan,
  choices: Map<string, RestoreResolution>,
): { navigation: Category[]; identities: NavigationIdentityMap } {
  const navigation = [...current.navigation];
  const identities = navigation.map((category) => mergedIdentity(category, current.navigationIdentities));
  const usedSlugs = new Set(navigation.map((item) => item.slug));

  for (const backupCategory of backup.navigation) {
    const backupId = categoryIdentity(backup.navigationIdentities, backupCategory);
    const currentIndex = identities.findIndex((item) => item.id === backupId)
      >= 0 ? identities.findIndex((item) => item.id === backupId)
      : navigation.findIndex((item) => item.slug === backupCategory.slug);
    const categoryConflicts = plan.conflicts.filter((entry) =>
      (entry.kind === 'navigation-identity' && entry.subject.navigationIdentity === backupId)
      || (entry.kind === 'navigation-ambiguous' && entry.subject.categorySlug === backupCategory.slug),
    );
    if (currentIndex < 0 && categoryConflicts.length === 0) {
      navigation.push(backupCategory);
      identities.push(mergedIdentity(backupCategory, backup.navigationIdentities));
      usedSlugs.add(backupCategory.slug);
      continue;
    }
    if (categoryConflicts.length === 0) continue;

    const identityConflict = categoryConflicts.find((entry) => entry.kind === 'navigation-identity') ?? categoryConflicts[0];
    const resolution = identityConflict ? choices.get(identityConflict.conflictId) : undefined;
    if (resolution === 'keep-current') continue;
    if (resolution === 'keep-both') {
      const slug = uniqueNavigationSlug(backupCategory.slug, identityConflict?.conflictId ?? backupId, usedSlugs);
      const copy = { ...backupCategory, slug };
      navigation.push(copy);
      identities.push(createNavigationIdentityMap([copy]).categories[0]!);
      continue;
    }
    if (currentIndex >= 0) {
      navigation[currentIndex] = backupCategory;
      identities[currentIndex] = mergedIdentity(backupCategory, backup.navigationIdentities);
    } else {
      navigation.push(backupCategory);
      identities.push(mergedIdentity(backupCategory, backup.navigationIdentities));
    }
    usedSlugs.add(backupCategory.slug);
  }
  return { navigation, identities: { schemaVersion: 1, categories: identities } };
}

function mergeSettings(current: SiteSettings, backup: SiteSettings, plan: RestorePlan, choices: Map<string, RestoreResolution>): SiteSettings {
  const merged = { ...current };
  for (const key of Object.keys(backup) as Array<keyof SiteSettings>) {
    const conflict = plan.conflicts.find((item) => item.kind === 'settings-field' && item.subject.settingKey === key);
    if (!conflict || choices.get(conflict.conflictId) === 'use-backup') {
      (merged as Record<keyof SiteSettings, string | boolean>)[key] = backup[key];
    }
  }
  return merged;
}

function safeRestoredPath(value: string): boolean {
  return isSafeMediaRelativePath(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.includes(':') && !value.includes('\0');
}

function assertNoSymlinkComponents(value: string): void {
  const root = path.resolve(getRuntimeDataRootPath());
  const targetRoot = path.resolve(root, 'media', value);
  const relative = path.relative(root, targetRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) failInvalidBackup(`恢复路径越界：${value}`);
  let cursor = root;
  const components = relative.split(path.sep);
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) failInvalidBackup(`恢复路径包含符号链接：${value}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function mediaPathForHash(asset: EditorMediaAsset, hash: string, occupied: Map<string, string>): string {
  const extension = path.posix.extname(asset.path) || '.bin';
  const base = `files/restored/${hash}${extension}`;
  let candidate = base;
  let suffix = 1;
  while (occupied.has(candidate) && occupied.get(candidate) !== hash) {
    const parsed = path.posix.parse(base);
    candidate = `${parsed.dir}/${parsed.name}-${suffix++}${parsed.ext}`;
  }
  return candidate;
}

function managedPathFromUrl(value: string): string | null {
  const match = /(?:https?:\/\/[^\s"'<>)]*)?\/media\/(files\/[\w./-]+)/.exec(value);
  const mediaPath = match?.[1]?.replace(/[.,;]+$/, '');
  return mediaPath && safeRestoredPath(mediaPath) ? mediaPath : null;
}

function collectMarkdownUrls(node: MarkdownNode, result: MarkdownNode[]): void {
  if ((node.type === 'link' || node.type === 'image') && node.url && node.position) result.push(node);
  node.children?.forEach((child) => collectMarkdownUrls(child, result));
}

function rewriteMarkdownMedia(markdown: string, pathMap: Map<string, string>): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MarkdownNode;
  const nodes: MarkdownNode[] = [];
  collectMarkdownUrls(tree, nodes);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !node.url) continue;
    const managedPath = managedPathFromUrl(node.url);
    const nextPath = managedPath ? pathMap.get(managedPath) : undefined;
    if (!managedPath || !nextPath) continue;
    const updatedUrl = node.url.replace(`/media/${managedPath}`, `/media/${nextPath}`);
    const fragment = markdown.slice(start, end);
    // The destination follows the last "](“ in the fragment. A link wrapping an
    // image whose URL equals the link's own destination also contains an earlier
    // "](“, and searching forward from that first one lands on the inner URL,
    // producing two overlapping replacements that corrupt the markdown.
    const destinationStart = fragment.lastIndexOf('](');
    const urlOffset = destinationStart >= 0
      ? fragment.indexOf(node.url, destinationStart + 2)
      : fragment.indexOf(node.url);
    if (urlOffset < 0) failInvalidBackup(`无法精确改写受管媒体引用：${managedPath}`);
    replacements.push({ start: start + urlOffset, end: start + urlOffset + node.url.length, value: updatedUrl });
  }
  let result = markdown;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function rewriteArticleMedia(articles: Article[], ids: Set<string>, pathMap: Map<string, string>): Article[] {
  if (pathMap.size === 0) return articles;
  return articles.map((article) => ids.has(article.id)
    ? { ...article, content: rewriteMarkdownMedia(article.content, pathMap) }
    : article);
}

function mergeMedia(
  current: RestorableEditorData['media'],
  backup: RestorableEditorData['media'],
  plan: RestorePlan,
  choices: Map<string, RestoreResolution>,
  mergedArticles: ReturnType<typeof mergeArticles>,
): { media: RestorableEditorData['media']; articles: Article[] } {
  const currentFiles = new Map(current.files.map((file) => [file.path, file.bytes]));
  const backupFiles = new Map(backup.files.map((file) => [file.path, file.bytes]));
  const currentAssets = new Map(current.manifest.assets.map((asset) => [asset.path, asset]));
  const backupAssets = new Map(backup.manifest.assets.map((asset) => [asset.path, asset]));
  const files = new Map<string, Uint8Array>();
  const assets = new Map<string, EditorMediaAsset>();
  const currentPathMap = new Map<string, string>();
  const backupPathMap = new Map<string, string>();
  const occupied = new Map<string, string>();

  for (const [mediaPath, asset] of currentAssets) {
    const bytes = currentFiles.get(mediaPath);
    if (!bytes) failInvalidBackup(`当前媒体文件缺失：${mediaPath}`);
    files.set(mediaPath, bytes);
    assets.set(mediaPath, asset);
    occupied.set(mediaPath, asset.hash);
  }
  for (const [mediaPath, backupAsset] of backupAssets) {
    const backupBytes = backupFiles.get(mediaPath);
    if (!backupBytes) failInvalidBackup(`备份媒体文件缺失：${mediaPath}`);
    const currentAsset = currentAssets.get(mediaPath);
    if (!currentAsset) {
      files.set(mediaPath, backupBytes);
      assets.set(mediaPath, backupAsset);
      occupied.set(mediaPath, backupAsset.hash);
      continue;
    }
    if (currentAsset.hash === backupAsset.hash) continue;

    const conflict = plan.conflicts.find((item) => item.kind === 'media-path' && item.subject.mediaPath === mediaPath);
    const resolution = conflict ? choices.get(conflict.conflictId) : undefined;
    if (resolution === 'use-backup') {
      const currentBytes = currentFiles.get(mediaPath);
      if (!currentBytes) failInvalidBackup(`当前媒体文件缺失：${mediaPath}`);
      const movedPath = mediaPathForHash(currentAsset, currentAsset.hash, occupied);
      const movedAsset = { ...currentAsset, path: movedPath, publicPath: `/media/${movedPath}` };
      files.delete(mediaPath);
      assets.delete(mediaPath);
      files.set(movedPath, currentBytes);
      assets.set(movedPath, movedAsset);
      occupied.set(movedPath, currentAsset.hash);
      currentPathMap.set(mediaPath, movedPath);
      files.set(mediaPath, backupBytes);
      assets.set(mediaPath, backupAsset);
      occupied.set(mediaPath, backupAsset.hash);
    } else {
      const movedPath = mediaPathForHash(backupAsset, backupAsset.hash, occupied);
      const movedAsset = { ...backupAsset, path: movedPath, publicPath: `/media/${movedPath}` };
      files.set(movedPath, backupBytes);
      assets.set(movedPath, movedAsset);
      occupied.set(movedPath, backupAsset.hash);
      backupPathMap.set(mediaPath, movedPath);
    }
  }

  const updatedArticles = rewriteArticleMedia(mergedArticles.articles, mergedArticles.backupIds, backupPathMap);
  const currentRewritten = rewriteArticleMedia(updatedArticles, mergedArticles.currentIds, currentPathMap);
  return {
    media: {
      manifest: { version: 1, updatedAt: new Date().toISOString(), assets: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)) },
      files: [...files]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, bytes]) => ({ path: filePath, bytes })),
    },
    articles: currentRewritten,
  };
}

function validateIdentityMap(data: RestorableEditorData): void {
  if (!data.navigationIdentities) return;
  if (data.navigationIdentities.schemaVersion !== 1 || !Array.isArray(data.navigationIdentities.categories)) {
    failInvalidBackup('导航身份清单格式无效。');
  }
  const ids = new Set<string>();
  for (const category of data.navigationIdentities.categories) {
    if (!category.id || ids.has(category.id) || !data.navigation.some((item) => item.slug === category.slug)) {
      failInvalidBackup('导航身份清单与导航数据不匹配。');
    }
    ids.add(category.id);
    const toolIds = new Set<string>();
    for (const tool of category.tools) {
      if (!tool.id || toolIds.has(tool.id) || !Number.isSafeInteger(tool.groupOrder) || tool.groupOrder < 0) {
        failInvalidBackup('导航工具身份清单无效。');
      }
      toolIds.add(tool.id);
    }
  }
}

function assertKnownObjectKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failInvalidBackup(`${label}结构无效。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) failInvalidBackup(`${label}包含不支持字段：${unknown.join(', ')}`);
}

function validateData(data: RestorableEditorData): RestorableEditorData {
  const articleKeys = ['id', 'slug', 'title', 'date', 'description', 'tags', 'content', 'createdAt', 'updatedAt', 'kind', 'status', 'category', 'series', 'featured', 'updatedDate', 'sourceLinks', 'revisionNotes', 'templateId'];
  const categoryKeys = ['name', 'icon', 'slug', 'tools'];
  const toolKeys = ['icon', 'title', 'description', 'url', 'tags'];
  const assetKeys = ['id', 'path', 'publicPath', 'mimeType', 'size', 'hash', 'createdAt', 'updatedAt'];
  data.articles.forEach((item) => assertKnownObjectKeys(item, articleKeys, '文章'));
  data.navigation.forEach((category) => {
    assertKnownObjectKeys(category, categoryKeys, '导航分类');
    category.tools.forEach((tool) => assertKnownObjectKeys(tool, toolKeys, '导航条目'));
  });
  assertKnownObjectKeys(data.settings, [...SITE_SETTING_KEYS, 'showIntroCard'], '站点设置');
  assertKnownObjectKeys(data.media.manifest, ['version', 'updatedAt', 'assets'], '媒体清单');
  data.media.manifest.assets.forEach((asset) => assertKnownObjectKeys(asset, assetKeys, '媒体资产'));
  data.media.files.forEach((file) => assertKnownObjectKeys(file, ['path', 'bytes'], '媒体文件'));

  const articles = parseArticlesDataOrThrow(data.articles);
  const navigation = parseNavigationDataOrThrow(data.navigation);
  const settings = parseSiteSettingsOrThrow(data.settings);
  validateArticlePaths(articles);
  validateIdentityMap({ ...data, articles, navigation, settings });
  if (stableJsonStringify(articles) !== stableJsonStringify(data.articles)
    || stableJsonStringify(navigation) !== stableJsonStringify(data.navigation)
    || stableJsonStringify(settings) !== stableJsonStringify(data.settings)) {
    failInvalidBackup('恢复数据经旧解析器归一化后发生变化，拒绝有损恢复。');
  }

  const manifest = parseEditorMediaManifest(data.media.manifest);
  if (!manifest || manifest.assets.length !== data.media.manifest.assets.length) failInvalidBackup('媒体清单格式无效。');
  const fileMap = new Map<string, Uint8Array>();
  for (const file of data.media.files) {
    if (!safeRestoredPath(file.path) || fileMap.has(file.path)) failInvalidBackup(`媒体路径无效或重复：${file.path}`);
    assertNoSymlinkComponents(file.path);
    fileMap.set(file.path, file.bytes);
  }
  if (fileMap.size !== manifest.assets.length) failInvalidBackup('恢复媒体文件与媒体清单不完整。');
  for (const asset of manifest.assets) {
    if (!safeRestoredPath(asset.path)) failInvalidBackup(`媒体路径无效：${asset.path}`);
    assertNoSymlinkComponents(asset.path);
    const bytes = fileMap.get(asset.path);
    if (!bytes || bytes.byteLength !== asset.size || sha256(bytes) !== asset.hash) failInvalidBackup(`媒体字节校验失败：${asset.path}`);
  }
  return { ...data, articles, navigation, settings, media: { manifest, files: data.media.files } };
}

function mergeRestorableData(
  current: RestorableEditorData,
  backup: RestorableEditorData,
  plan: RestorePlan,
  choices: Map<string, RestoreResolution>,
): RestorableEditorData {
  const mergedArticles = mergeArticles(current.articles, backup.articles, plan, choices);
  const mergedNavigation = mergeNavigation(current, backup, plan, choices);
  const merged = mergeMedia(current.media, backup.media, plan, choices, mergedArticles);
  return {
    articles: merged.articles,
    navigation: mergedNavigation.navigation,
    settings: mergeSettings(current.settings, backup.settings, plan, choices),
    navigationIdentities: mergedNavigation.identities,
    media: merged.media,
  };
}

function currentDataRevision(data: RestorableEditorData): string {
  return sha256(createRestoreContentDigest(data));
}

async function readCurrentData(): Promise<{ data: RestorableEditorData; revision: string }> {
  const mediaManifest = readEditorMediaManifest();
  const files = await Promise.all(mediaManifest.assets.map(async (asset) => {
    const bytes = await readEditorMediaFile(asset);
    if (!bytes || bytes.byteLength !== asset.size || sha256(bytes) !== asset.hash) failInvalidBackup(`当前媒体缺失或损坏：${asset.path}`);
    return { path: asset.path, bytes };
  }));
  const data: RestorableEditorData = {
    articles: readArticlesFromDisk(),
    navigation: readNavigationFromDisk(),
    settings: readSiteSettingsFromDisk(),
    navigationIdentities: readNavigationIdentities(),
    media: { manifest: mediaManifest, files },
  };
  return { data, revision: currentDataRevision(data) };
}

function createProtectionCopy(current: RestorableEditorData): Promise<void> {
  const payload = createEditorBackupPayload({
    articles: current.articles,
    navigation: current.navigation,
    settings: current.settings,
    media: { manifest: current.media.manifest, files: current.media.files },
  });
  const directory = path.join(getRuntimeDataRootPath(), 'workflow', 'recovery', 'restore-protection');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path.join(directory, `${Date.now()}-${randomUUID()}.json`), payload, { mode: 0o600 });
  return Promise.resolve();
}

async function stageMergedData(data: RestorableEditorData): Promise<StagedRestore> {
  const root = path.join(getRuntimeDataRootPath(), 'workflow', 'recovery', 'restore-staging');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, randomUUID());
  fs.mkdirSync(directory, { mode: 0o700 });
  writeJsonAtomically(path.join(directory, 'articles.json'), data.articles);
  writeJsonAtomically(path.join(directory, 'navigation.json'), data.navigation);
  writeJsonAtomically(path.join(directory, 'settings.json'), data.settings);
  writeJsonAtomically(path.join(directory, 'navigation-identities.json'), data.navigationIdentities);
  writeJsonAtomically(path.join(directory, 'media-manifest.json'), data.media.manifest);
  for (const file of data.media.files) {
    if (!safeRestoredPath(file.path)) failInvalidBackup(`媒体路径无效：${file.path}`);
    assertNoSymlinkComponents(file.path);
    const target = path.resolve(directory, 'media', file.path);
    if (!target.startsWith(`${path.resolve(directory, 'media')}${path.sep}`)) failInvalidBackup(`媒体路径越界：${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const relative = path.relative(directory, target);
    let cursor = directory;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      cursor = path.join(cursor, segment);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) failInvalidBackup(`staging 包含符号链接：${file.path}`);
    }
    fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  return { directory };
}

async function validateStagedData(staged: unknown): Promise<RestorableEditorData> {
  if (!staged || typeof staged !== 'object' || typeof (staged as StagedRestore).directory !== 'string') failInvalidBackup('恢复 staging 引用无效。');
  const directory = path.resolve((staged as StagedRestore).directory);
  const root = path.resolve(getRuntimeDataRootPath(), 'workflow', 'recovery', 'restore-staging');
  if (!directory.startsWith(`${root}${path.sep}`)) failInvalidBackup('恢复 staging 路径越界。');
  const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as unknown;
  const manifest = parseEditorMediaManifest(readJson('media-manifest.json'));
  if (!manifest) failInvalidBackup('staging 媒体清单无效。');
  const mediaFiles = manifest.assets.map((asset) => {
    const target = path.resolve(directory, 'media', asset.path);
    if (!target.startsWith(`${path.resolve(directory, 'media')}${path.sep}`)) failInvalidBackup(`staging 媒体路径越界：${asset.path}`);
    let cursor = path.resolve(directory);
    const relative = path.relative(directory, target);
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) failInvalidBackup(`staging 包含符号链接：${asset.path}`);
    }
    return { path: asset.path, bytes: new Uint8Array(fs.readFileSync(target)) };
  });
  return validateData({
    articles: readJson('articles.json') as Article[],
    navigation: readJson('navigation.json') as Category[],
    settings: readJson('settings.json') as SiteSettings,
    navigationIdentities: readJson('navigation-identities.json') as NavigationIdentityMap | null,
    media: { manifest, files: mediaFiles },
  });
}

async function applyAtomically(data: RestorableEditorData): Promise<unknown> {
  const result = await restoreEditorDataRootAtomically({
    articles: data.articles,
    navigation: data.navigation,
    settings: data.settings,
    media: { manifest: data.media.manifest, files: data.media.files },
  });
  writeNavigationIdentities(data.navigationIdentities ?? createNavigationIdentityMap(data.navigation));
  return result;
}

async function defaultBackupState(): Promise<{ generation: string; backedUpThrough: number; contentSequence: number }> {
  const { generation, backedUpThrough, contentSequence } = await readBackupWatermark();
  return { generation, backedUpThrough, contentSequence };
}

function validatePlanBinding(plan: RestorePlan): void {
  if (plan.schemaVersion !== 1 || plan.planDigest !== sha256(stableJsonStringify({
    schemaVersion: plan.schemaVersion,
    binding: plan.binding,
    added: plan.added,
    identical: plan.identical,
    conflicts: plan.conflicts,
  }))) failInvalidSelection('恢复计划摘要无效。');
}

export async function applyRestorePlan(
  plan: RestorePlan,
  choices: RestoreChoice[],
  injected: RestoreApplyDependencies,
): Promise<RestoreApplicationResult> {
  validatePlanBinding(plan);
  const selected = conflictChoiceMap(plan, choices);
  const backup = await injected.readBackup(plan.binding.backupCommit);
  if (backup.commit !== plan.binding.backupCommit || createRestoreContentDigest(backup.data) !== plan.binding.backupContentDigest) {
    throw new RestoreApplicationError(409, 'REVISION_CONFLICT', '备份提交或内容摘要已变化，请重新生成恢复计划。');
  }
  const withLock = injected.withLock ?? withEditorDataRootLock;
  return withLock(async () => {
    const currentSnapshot = await injected.readCurrent();
    if (currentSnapshot.revision !== plan.binding.currentRevision
      || createRestoreContentDigest(currentSnapshot.data) !== plan.binding.currentContentDigest) {
      throw new RestoreApplicationError(409, 'REVISION_CONFLICT', '本地内容已变化，请重新生成恢复计划。');
    }
    const rebuilt = createRestorePlan(currentSnapshot.data, backup.data, {
      currentRevision: currentSnapshot.revision,
      backupCommit: backup.commit,
    });
    if (rebuilt.planDigest !== plan.planDigest) failInvalidSelection('恢复计划摘要无效。');

    const current = validateData(currentSnapshot.data);
    const decodedBackup = validateData(backup.data);
    await (injected.takeProtectionCopy ?? createProtectionCopy)(current);
    const merged = validateData(mergeRestorableData(current, decodedBackup, plan, selected));
    const staged = await (injected.stage ?? stageMergedData)(merged);
    const validated = validateData(await (injected.validateStage ?? validateStagedData)(staged));
    if (createRestoreContentDigest(validated) !== createRestoreContentDigest(merged)) {
      failInvalidBackup('恢复 staging 与已确认的合并内容不一致。');
    }
    const transactionResult = await (injected.applyAtomically ?? applyAtomically)(validated);
    if (injected.persistNavigationIdentities) await injected.persistNavigationIdentities(validated);
    const watermark = await (injected.readBackupState ?? defaultBackupState)();
    if (staged && typeof staged === 'object' && 'directory' in staged) {
      fs.rmSync((staged as StagedRestore).directory, { recursive: true, force: true });
    }
    return { data: validated, generation: watermark.generation, backupCaughtUp: false, transactionResult };
  });
}

export async function readCurrentRestoreState(): Promise<{ data: RestorableEditorData; revision: string }> {
  return readCurrentData();
}

export function createRestorePayloadDecoder(input: {
  decode(value: unknown): Promise<RestorableEditorData> | RestorableEditorData;
}): (value: unknown) => Promise<RestorableEditorData> {
  return async (value) => validateData(await input.decode(value));
}

export const RESTORE_SETTING_DEFAULTS: SiteSettings = { ...DEFAULT_SITE_SETTINGS };
