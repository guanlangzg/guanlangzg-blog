import { createHash } from 'node:crypto';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { EditorMediaManifest } from '@/lib/editor-media-storage';
import { normalizeNavigationUrl, type NavigationIdentityMap } from '@/lib/navigation-identities';
import { stableJsonStringify } from '@/lib/stable-json';
import type { SiteSettings } from '@/lib/site-settings';

export type RestoreResolution = 'keep-current' | 'use-backup' | 'keep-both';

export type RestoreConflictKind =
  | 'article-id'
  | 'article-slug'
  | 'article-legacy-ambiguous'
  | 'navigation-identity'
  | 'navigation-ambiguous'
  | 'settings-field'
  | 'media-path';

export interface RestorableEditorData {
  articles: Article[];
  navigation: Category[];
  settings: SiteSettings;
  navigationIdentities: NavigationIdentityMap | null;
  media: {
    manifest: EditorMediaManifest;
    files: Array<{ path: string; bytes: Uint8Array }>;
  };
}

export interface RestoreConflict {
  conflictId: string;
  kind: RestoreConflictKind;
  summary: string;
  resolutions: readonly RestoreResolution[];
  subject: {
    articleId?: string;
    currentArticleId?: string;
    backupArticleId?: string;
    slug?: string;
    categorySlug?: string;
    navigationIdentity?: string;
    normalizedUrl?: string;
    settingKey?: keyof SiteSettings;
    mediaPath?: string;
  };
}

export interface RestoreInventoryItem {
  itemId: string;
  summary: string;
}

export interface RestorePlanBinding {
  currentRevision: string;
  backupCommit: string;
  backupContentDigest: string;
  currentContentDigest: string;
}

export interface RestorePlan {
  schemaVersion: 1;
  planDigest: string;
  binding: RestorePlanBinding;
  added: {
    articles: readonly RestoreInventoryItem[];
    navigation: readonly RestoreInventoryItem[];
    settings: readonly RestoreInventoryItem[];
    media: readonly RestoreInventoryItem[];
  };
  identical: {
    articles: readonly RestoreInventoryItem[];
    navigation: readonly RestoreInventoryItem[];
    settings: readonly RestoreInventoryItem[];
    media: readonly RestoreInventoryItem[];
  };
  conflicts: readonly RestoreConflict[];
}

const ALL_RESOLUTIONS: readonly RestoreResolution[] = ['keep-current', 'use-backup', 'keep-both'];
const SINGLE_VALUE_RESOLUTIONS: readonly RestoreResolution[] = ['keep-current', 'use-backup'];

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashValue(value: unknown): string {
  return sha256(stableJsonStringify(value));
}

export function createRestoreContentDigest(data: RestorableEditorData): string {
  return hashValue({
    articles: data.articles,
    navigation: data.navigation,
    navigationIdentities: data.navigationIdentities,
    settings: data.settings,
    media: {
      manifest: data.media.manifest,
      files: data.media.files
        .map((file) => ({ path: file.path, hash: sha256(file.bytes), size: file.bytes.byteLength }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  });
}

function articleSlug(article: Article): string {
  return article.slug ?? article.id;
}

function articleEqual(left: Article, right: Article): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function conflictId(kind: RestoreConflictKind, subject: RestoreConflict['subject']): string {
  return `restore-${sha256(`${kind}:${stableJsonStringify(subject)}`).slice(0, 24)}`;
}

function createConflict(
  kind: RestoreConflictKind,
  summary: string,
  subject: RestoreConflict['subject'],
  resolutions: readonly RestoreResolution[] = ALL_RESOLUTIONS,
): RestoreConflict {
  return {
    conflictId: conflictId(kind, subject),
    kind,
    summary,
    resolutions: [...resolutions],
    subject,
  };
}

function inventory(itemId: string, summary: string): RestoreInventoryItem {
  return { itemId, summary };
}

function navigationCategoryIdentity(
  identities: NavigationIdentityMap | null,
  category: Category,
): string {
  return identities?.categories.find((item) => item.slug === category.slug)?.id ?? `legacy:${category.slug}`;
}

function navigationEqual(left: Category, right: Category): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function buildNavigationInventory(current: RestorableEditorData, backup: RestorableEditorData, conflicts: RestoreConflict[]) {
  const added: RestoreInventoryItem[] = [];
  const identical: RestoreInventoryItem[] = [];
  const currentById = new Map(current.navigation.map((item) => [navigationCategoryIdentity(current.navigationIdentities, item), item]));
  const currentBySlug = new Map(current.navigation.map((item) => [item.slug, item]));
  const backupById = new Map(backup.navigation.map((item) => [navigationCategoryIdentity(backup.navigationIdentities, item), item]));

  for (const backupCategory of backup.navigation) {
    const id = navigationCategoryIdentity(backup.navigationIdentities, backupCategory);
    // Stable identity is only comparable when both sides keep an identity map; the slug is the
    // legacy-stable key and mirrors how the merge step matches a category to its current version.
    const match = currentById.get(id) ?? currentBySlug.get(backupCategory.slug);
    if (!match) {
      added.push(inventory(id, `新增导航分类：${backupCategory.name}`));
      continue;
    }
    if (navigationEqual(match, backupCategory)) {
      identical.push(inventory(id, `相同导航分类：${backupCategory.name}`));
      continue;
    }
    const subject = { navigationIdentity: id, categorySlug: backupCategory.slug };
    conflicts.push(createConflict('navigation-identity', `导航分类“${match.name}”与备份中的“${backupCategory.name}”属于同一分类但内容不同。`, subject));

    // Tools that exist only in the backup are merged in, so the plan has to list them.
    const currentToolUrls = new Set(match.tools.map((tool) => normalizeNavigationUrl(tool.url)));
    for (const backupTool of backupCategory.tools) {
      const normalizedUrl = normalizeNavigationUrl(backupTool.url);
      if (currentToolUrls.has(normalizedUrl)) continue;
      added.push(inventory(
        `${backupCategory.slug}#${normalizedUrl}`,
        `新增导航条目：${backupTool.title}（${backupCategory.name}）`,
      ));
    }
  }

  const currentWithoutIdentity = current.navigationIdentities === null;
  const backupWithoutIdentity = backup.navigationIdentities === null;
  if (currentWithoutIdentity || backupWithoutIdentity) {
    for (const backupCategory of backup.navigation) {
      const currentCategory = current.navigation.find((item) => item.slug === backupCategory.slug);
      if (!currentCategory) continue;
      for (const backupTool of backupCategory.tools) {
        const normalizedUrl = normalizeNavigationUrl(backupTool.url);
        const candidates = currentCategory.tools.filter((item) => normalizeNavigationUrl(item.url) === normalizedUrl);
        const backupMatches = backupCategory.tools.filter((item) => normalizeNavigationUrl(item.url) === normalizedUrl);
        if (candidates.length > 1 || backupMatches.length > 1) {
          const subject = { categorySlug: backupCategory.slug, normalizedUrl };
          const id = conflictId('navigation-ambiguous', subject);
          if (!conflicts.some((item) => item.conflictId === id)) {
            conflicts.push(createConflict('navigation-ambiguous', `导航“${backupTool.title}”在分类“${backupCategory.name}”中存在多个旧数据匹配，无法确认稳定身份。`, subject));
          }
        } else if (candidates.length === 1 && stableJsonStringify(candidates[0]) !== stableJsonStringify(backupTool)) {
          const subject = { categorySlug: backupCategory.slug, normalizedUrl };
          const id = conflictId('navigation-identity', subject);
          if (!conflicts.some((item) => item.conflictId === id)) {
            conflicts.push(createConflict('navigation-identity', `导航“${backupTool.title}”与现有的唯一旧数据匹配项内容不同。`, subject));
          }
        }
      }
    }
  }

  for (const currentCategory of current.navigation) {
    const id = navigationCategoryIdentity(current.navigationIdentities, currentCategory);
    if (!backupById.has(id)) continue;
    if (!backup.navigation.some((item) => navigationCategoryIdentity(backup.navigationIdentities, item) === id)) continue;
  }
  return { added, identical };
}

function buildPlanParts(current: RestorableEditorData, backup: RestorableEditorData) {
  const conflicts: RestoreConflict[] = [];
  const addedArticles: RestoreInventoryItem[] = [];
  const identicalArticles: RestoreInventoryItem[] = [];
  const currentById = new Map(current.articles.filter((item) => item.id.trim()).map((item) => [item.id, item]));
  const currentBySlug = new Map(current.articles.map((item) => [articleSlug(item).toLocaleLowerCase('en-US'), item]));
  const backupIdCounts = new Map<string, number>();
  const backupSlugCounts = new Map<string, number>();
  for (const item of backup.articles) {
    if (item.id.trim()) backupIdCounts.set(item.id, (backupIdCounts.get(item.id) ?? 0) + 1);
    const slug = articleSlug(item).toLocaleLowerCase('en-US');
    backupSlugCounts.set(slug, (backupSlugCounts.get(slug) ?? 0) + 1);
  }

  for (const backupArticle of backup.articles) {
    const id = backupArticle.id.trim();
    const slugKey = articleSlug(backupArticle).toLocaleLowerCase('en-US');
    if (!id || backupIdCounts.get(id) !== 1) {
      const subject = { backupArticleId: backupArticle.id, slug: articleSlug(backupArticle) };
      conflicts.push(createConflict('article-legacy-ambiguous', `备份文章“${backupArticle.title}”缺少唯一稳定 ID，需选择如何处理。`, subject));
      continue;
    }

    const byId = currentById.get(id);
    const bySlug = currentBySlug.get(slugKey);
    if (byId) {
      if (articleEqual(byId, backupArticle)) {
        identicalArticles.push(inventory(id, `相同文章：${backupArticle.title}`));
      } else {
        const subject = { articleId: id, currentArticleId: id, backupArticleId: id };
        conflicts.push(createConflict('article-id', `文章 ID“${id}”的当前内容与备份不同。`, subject));
      }
      continue;
    }
    if (bySlug && bySlug.id !== id) {
      const subject = { currentArticleId: bySlug.id, backupArticleId: id, slug: articleSlug(backupArticle) };
      conflicts.push(createConflict('article-slug', `文章“${bySlug.title}”与备份文章“${backupArticle.title}”使用相同 slug“${articleSlug(backupArticle)}”。`, subject));
      continue;
    }
    if (backupSlugCounts.get(slugKey) !== 1) {
      const subject = { backupArticleId: id, slug: articleSlug(backupArticle) };
      conflicts.push(createConflict('article-slug', `备份中有多个文章使用 slug“${articleSlug(backupArticle)}”。`, subject));
      continue;
    }
    addedArticles.push(inventory(id, `新增文章：${backupArticle.title}`));
  }

  const navigation = buildNavigationInventory(current, backup, conflicts);
  const addedSettings: RestoreInventoryItem[] = [];
  const identicalSettings: RestoreInventoryItem[] = [];
  for (const key of Object.keys(backup.settings) as Array<keyof SiteSettings>) {
    if (current.settings[key] === backup.settings[key]) {
      identicalSettings.push(inventory(String(key), `相同站点设置：${key}`));
    } else {
      const subject = { settingKey: key };
      conflicts.push(createConflict('settings-field', `站点设置“${key}”当前值与备份值不同。`, subject, SINGLE_VALUE_RESOLUTIONS));
    }
  }

  const currentMedia = new Map(current.media.manifest.assets.map((asset) => [asset.path, asset]));
  const backupMedia = new Map(backup.media.manifest.assets.map((asset) => [asset.path, asset]));
  const addedMedia: RestoreInventoryItem[] = [];
  const identicalMedia: RestoreInventoryItem[] = [];
  for (const [mediaPath, asset] of backupMedia) {
    const match = currentMedia.get(mediaPath);
    if (!match) {
      addedMedia.push(inventory(mediaPath, `新增媒体：${mediaPath}`));
    } else if (match.hash === asset.hash && match.size === asset.size) {
      identicalMedia.push(inventory(mediaPath, `相同媒体：${mediaPath}`));
    } else {
      const subject = { mediaPath };
      conflicts.push(createConflict('media-path', `媒体路径“${mediaPath}”在当前数据和备份中对应不同字节。`, subject));
    }
  }

  return {
    conflicts: conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
    added: {
      articles: addedArticles,
      navigation: navigation.added,
      settings: addedSettings,
      media: addedMedia,
    },
    identical: {
      articles: identicalArticles,
      navigation: navigation.identical,
      settings: identicalSettings,
      media: identicalMedia,
    },
  };
}

export function createRestorePlan(
  current: RestorableEditorData,
  backup: RestorableEditorData,
  input: { currentRevision: string; backupCommit: string },
): RestorePlan {
  const parts = buildPlanParts(current, backup);
  const binding: RestorePlanBinding = {
    currentRevision: input.currentRevision,
    backupCommit: input.backupCommit,
    backupContentDigest: createRestoreContentDigest(backup),
    currentContentDigest: createRestoreContentDigest(current),
  };
  const body = {
    schemaVersion: 1 as const,
    binding,
    added: parts.added,
    identical: parts.identical,
    conflicts: parts.conflicts,
  };
  const planDigest = sha256(stableJsonStringify(body));
  return deepFreeze({ ...body, planDigest }) as RestorePlan;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
