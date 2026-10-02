import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEncryptedBackupPayload } from './encrypted-backup.mjs';

export const MANIFEST_VERSION = 1;
export const DATA_SCHEMA_VERSION = 1;
export const BACKUP_VERSION = 1;
export const MEDIA_MANIFEST_VERSION = 1;

export const DATA_MIGRATIONS = [];

const MEDIA_MANIFEST_FILE_NAME = 'manifest.json';
const MEDIA_FILES_DIRECTORY_NAME = 'files';

export const DEFAULT_SITE_SETTINGS = {
  siteName: '观澜志',
  siteDescription: '记录值得回看的文章与实用导航。',
  workspaceLabel: '观澜志 / 文章与导航',
  heroTitleLineOne: '记录值得回看的内容，',
  heroTitleLineTwo: '整理实用的知识与导航',
  heroDescription:
    '观澜志收录公开文章与常用导航，帮助读者查找、阅读和整理信息。',
  showIntroCard: true,
  introCardEyebrow: '观澜志',
  introCardTitle: '文章与导航，一处查阅',
  introCardDescription:
    '浏览站点公开文章，或从分类导航中查找常用网站与参考资料。',
  introCardMetaOneLabel: '内容',
  introCardMetaOneValue: '公开文章与实用导航',
  introCardMetaTwoLabel: '文章',
  introCardMetaTwoValue: '按主题查阅文章与笔记',
  introCardMetaThreeLabel: '导航',
  introCardMetaThreeValue: '按分类查找网站与工具',
  introCardStartLabel: '开始浏览',
};

export const SITE_SETTING_KEYS = [
  'siteName',
  'siteDescription',
  'workspaceLabel',
  'heroTitleLineOne',
  'heroTitleLineTwo',
  'heroDescription',
  'introCardEyebrow',
  'introCardTitle',
  'introCardDescription',
  'introCardMetaOneLabel',
  'introCardMetaOneValue',
  'introCardMetaTwoLabel',
  'introCardMetaTwoValue',
  'introCardMetaThreeLabel',
  'introCardMetaThreeValue',
  'introCardStartLabel',
];

const LEGACY_SITE_SETTING_KEYS = [
  'siteName',
  'siteDescription',
  'workspaceLabel',
  'heroTitleLineOne',
  'heroTitleLineTwo',
  'heroDescription',
];

const DEFAULTED_SITE_SETTING_KEYS = [
  'introCardEyebrow',
  'introCardTitle',
  'introCardDescription',
  'introCardMetaOneLabel',
  'introCardMetaOneValue',
  'introCardMetaTwoLabel',
  'introCardMetaTwoValue',
  'introCardMetaThreeLabel',
  'introCardMetaThreeValue',
  'introCardStartLabel',
];

export function resolveDataRoot(input) {
  return path.resolve(input || process.env.BLOG_DATA_ROOT || 'data');
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT';
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function canWriteDirectorySync(pathname) {
  const stats = fs.statSync(pathname);

  if (!stats.isDirectory()) {
    return false;
  }

  fs.accessSync(pathname, fs.constants.W_OK);
  return true;
}

export function isRuntimeDataRootWritableSync(pathname) {
  let currentPath = path.resolve(pathname);

  while (true) {
    try {
      return canWriteDirectorySync(currentPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        return false;
      }
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      return false;
    }

    currentPath = parentPath;
  }
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const parsed = readJsonFile(filePath);

  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array.`);
  }

  return parsed;
}

export function readJsonObject(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const parsed = readJsonFile(filePath);

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

export function createDefaultSiteSettings() {
  return { ...DEFAULT_SITE_SETTINGS };
}

function normalizeSlugPart(value) {
  return String(value)
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function normalizeIdSuffix(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-6) || 'entry';
}

export function createArticleSlug(article) {
  const base = normalizeSlugPart(article.title) || 'article';
  return `${base}-${normalizeIdSuffix(article.id)}`;
}

function normalizeArticleSlug(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const slug = normalizeSlugPart(value);
  return slug.length > 0 ? slug : null;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeArticle(article) {
  if (!isRecord(article) || Array.isArray(article)) {
    throw new Error('Article data must contain JSON objects.');
  }

  if (
    typeof article.id !== 'string' ||
    typeof article.title !== 'string' ||
    typeof article.date !== 'string' ||
    typeof article.description !== 'string' ||
    !isStringArray(article.tags) ||
    typeof article.content !== 'string' ||
    !isFiniteNumber(article.createdAt) ||
    !isFiniteNumber(article.updatedAt) ||
    (article.slug !== undefined && typeof article.slug !== 'string')
  ) {
    throw new Error(
      'Articles must include id, title, date, description, tags, content, createdAt, and updatedAt with valid types.'
    );
  }

  return {
    ...article,
    slug: normalizeArticleSlug(article.slug) || createArticleSlug(article),
  };
}

export function normalizeArticles(articles) {
  const slugs = new Set();

  return articles.map((article) => {
    const normalized = normalizeArticle(article);

    if (slugs.has(normalized.slug)) {
      throw new Error(`Duplicate article slug: ${normalized.slug}`);
    }

    slugs.add(normalized.slug);
    return normalized;
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeSiteSettings(value) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Site settings must contain a JSON object.');
  }

  const settings = {};

  for (const key of LEGACY_SITE_SETTING_KEYS) {
    if (!isNonEmptyString(value[key])) {
      throw new Error(`Site settings must include a non-empty ${key}.`);
    }

    settings[key] = value[key].trim();
  }

  for (const key of DEFAULTED_SITE_SETTING_KEYS) {
    if (value[key] === undefined) {
      settings[key] = DEFAULT_SITE_SETTINGS[key];
      continue;
    }

    if (!isNonEmptyString(value[key])) {
      throw new Error(`Site settings must include a non-empty ${key}.`);
    }

    settings[key] = value[key].trim();
  }

  if (value.showIntroCard === undefined) {
    settings.showIntroCard = DEFAULT_SITE_SETTINGS.showIntroCard;
  } else if (typeof value.showIntroCard === 'boolean') {
    settings.showIntroCard = value.showIntroCard;
  } else {
    throw new Error('Site settings showIntroCard must be a boolean when present.');
  }

  return settings;
}

function readSiteSettings(filePath) {
  if (!fs.existsSync(filePath)) {
    return createDefaultSiteSettings();
  }

  return normalizeSiteSettings(readJsonFile(filePath));
}

function createNavigationSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeNavigationTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isNonEmptyString)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function isValidNavigationUrl(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value.trim());

    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeNavigationTool(value) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Navigation tools must contain JSON objects.');
  }

  if (
    !isNonEmptyString(value.icon) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.description) ||
    !isValidNavigationUrl(value.url)
  ) {
    throw new Error('Navigation tools must include icon, title, description, and an HTTPS url.');
  }

  const tags = normalizeNavigationTags(value.tags);

  if (tags.length === 0) {
    throw new Error('Navigation tools must include at least one tag.');
  }

  return {
    icon: value.icon.trim(),
    title: value.title.trim(),
    description: value.description.trim(),
    url: value.url.trim(),
    tags,
  };
}

function normalizeNavigationCategory(value) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Navigation categories must contain JSON objects.');
  }

  if (
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.icon) ||
    !Array.isArray(value.tools)
  ) {
    throw new Error('Navigation categories must include name, icon, and tools array.');
  }

  const slug = createNavigationSlug(isNonEmptyString(value.slug) ? value.slug : value.name);

  if (!slug) {
    throw new Error('Navigation categories must have a valid slug.');
  }

  return {
    name: value.name.trim(),
    icon: value.icon.trim(),
    slug,
    tools: value.tools.map(normalizeNavigationTool),
  };
}

export function normalizeNavigation(navigation) {
  if (!Array.isArray(navigation)) {
    throw new Error('Navigation data must contain a JSON array.');
  }

  const slugs = new Set();

  return navigation.map((category) => {
    const normalized = normalizeNavigationCategory(category);

    if (slugs.has(normalized.slug)) {
      throw new Error(`Duplicate navigation category slug: ${normalized.slug}`);
    }

    slugs.add(normalized.slug);
    return normalized;
  });
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);

  return `{${entries.join(',')}}`;
}

export function hashJson(value) {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex');
}

function createBase64Bytes(value) {
  return Buffer.from(value).toString('base64');
}

function parseBase64Bytes(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, 'base64'));
}

function hashBytes(value) {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}

function getMediaRoot(dataRoot) {
  return path.join(dataRoot, 'media');
}

function getMediaManifestPath(dataRoot) {
  return path.join(getMediaRoot(dataRoot), MEDIA_MANIFEST_FILE_NAME);
}

function getMediaFilesRoot(dataRoot) {
  return path.join(getMediaRoot(dataRoot), MEDIA_FILES_DIRECTORY_NAME);
}

function createEmptyMediaManifest() {
  return {
    version: MEDIA_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    assets: [],
  };
}

function isSafeMediaRelativePath(value) {
  const normalized = value.replace(/\\/g, '/');

  return (
    normalized === value &&
    normalized.startsWith(`${MEDIA_FILES_DIRECTORY_NAME}/`) &&
    !normalized.startsWith('/') &&
    !normalized.includes('../') &&
    !normalized.includes('/..') &&
    normalized.split('/').every(Boolean)
  );
}

function isValidMediaMimeType(value) {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isMediaAsset(value) {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    isSafeMediaRelativePath(value.path) &&
    typeof value.publicPath === 'string' &&
    value.publicPath === `/media/${value.path}` &&
    isValidMediaMimeType(value.mimeType) &&
    isFiniteNonNegativeNumber(value.size) &&
    typeof value.hash === 'string' &&
    value.hash === value.id &&
    /^[a-f0-9]{64}$/i.test(value.hash) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function parseMediaManifest(value) {
  if (!isRecord(value) || value.version !== MEDIA_MANIFEST_VERSION || !Array.isArray(value.assets)) {
    return null;
  }

  if (value.assets.some((asset) => !isMediaAsset(asset))) {
    return null;
  }

  return {
    version: MEDIA_MANIFEST_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    assets: value.assets,
  };
}

function readMediaManifest(dataRoot) {
  const manifestPath = getMediaManifestPath(dataRoot);

  if (!fs.existsSync(manifestPath)) {
    return createEmptyMediaManifest();
  }

  const manifest = parseMediaManifest(readJsonFile(manifestPath));

  if (!manifest) {
    throw new Error(`${manifestPath} is invalid.`);
  }

  return manifest;
}

function resolveMediaFilePath(dataRoot, mediaPath) {
  if (!isSafeMediaRelativePath(mediaPath)) {
    throw new Error(`Invalid media path: ${mediaPath}`);
  }

  const filesRoot = path.resolve(getMediaFilesRoot(dataRoot));
  const filePath = path.resolve(getMediaRoot(dataRoot), mediaPath);

  if (filePath !== filesRoot && !filePath.startsWith(`${filesRoot}${path.sep}`)) {
    throw new Error(`Invalid media path: ${mediaPath}`);
  }

  return filePath;
}

function readMediaFile(dataRoot, asset) {
  return new Uint8Array(fs.readFileSync(resolveMediaFilePath(dataRoot, asset.path)));
}

function writeMediaFile(dataRoot, asset, bytes) {
  if (hashBytes(bytes) !== asset.hash) {
    throw new Error(`Media file hash does not match manifest: ${asset.path}`);
  }

  const filePath = resolveMediaFilePath(dataRoot, asset.path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function writeRestoredMediaManifest(dataRoot, manifest) {
  writeJsonAtomically(getMediaManifestPath(dataRoot), {
    version: MEDIA_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    assets: manifest.assets,
  });
}

function readRuntimeBackupMedia(dataRoot, includeFiles = true) {
  const manifest = readMediaManifest(dataRoot);

  if (!includeFiles) {
    return { manifest };
  }

  return {
    manifest,
    files: manifest.assets.map((asset) => ({
      path: asset.path,
      bytes: readMediaFile(dataRoot, asset),
    })),
  };
}

function serializeBackupMedia(media) {
  if (!media) {
    return undefined;
  }

  if (!media.files) {
    return media.manifest;
  }

  return {
    manifest: media.manifest,
    files: media.files.map((file) => ({
      path: file.path,
      data: createBase64Bytes(file.bytes),
    })),
  };
}

function parseBackupMedia(value) {
  if (value === undefined) {
    return undefined;
  }

  const legacyManifest = parseMediaManifest(value);

  if (legacyManifest) {
    return {
      manifest: legacyManifest,
    };
  }

  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Backup media data is invalid.');
  }

  const manifest = parseMediaManifest(value.manifest);

  if (!manifest) {
    throw new Error('Backup media manifest is invalid.');
  }

  if (value.files === undefined) {
    return {
      manifest,
    };
  }

  if (!Array.isArray(value.files)) {
    throw new Error('Backup media files must be an array.');
  }

  const assetsByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const seenPaths = new Set();
  const files = value.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.data !== 'string') {
      throw new Error('Backup media file is invalid.');
    }

    const asset = assetsByPath.get(file.path);

    if (!asset || seenPaths.has(file.path)) {
      throw new Error(`Backup media file is unexpected: ${file.path}`);
    }

    const bytes = parseBase64Bytes(file.data);

    if (!bytes || bytes.byteLength !== asset.size || hashBytes(bytes) !== asset.hash) {
      throw new Error(`Backup media file failed validation: ${file.path}`);
    }

    seenPaths.add(file.path);

    return {
      path: file.path,
      bytes,
    };
  });

  return {
    manifest,
    files,
  };
}

function hasRequiredInlineMediaFiles(media) {
  if (!media) {
    return true;
  }

  const assetPaths = media.manifest.assets.map((asset) => asset.path);

  if (assetPaths.length === 0) {
    return true;
  }

  if (!media.files || media.files.length !== assetPaths.length) {
    return false;
  }

  const filePaths = new Set(media.files.map((file) => file.path));

  return filePaths.size === assetPaths.length && assetPaths.every((assetPath) => filePaths.has(assetPath));
}

function writeRestoredMediaData(dataRoot, media) {
  const assetsByPath = new Map(media.manifest.assets.map((asset) => [asset.path, asset]));

  for (const file of media.files || []) {
    const asset = assetsByPath.get(file.path);

    if (!asset) {
      throw new Error(`Backup media file is unexpected: ${file.path}`);
    }

    writeMediaFile(dataRoot, asset, file.bytes);
  }

  writeRestoredMediaManifest(dataRoot, media.manifest);
}

export function createResourceManifest(value) {
  const hash = hashJson(value);
  const updatedAt = new Date().toISOString();

  return {
    revision: `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-${hash.slice(0, 12)}`,
    hash,
    updatedAt,
  };
}

export function createManifest(data) {
  const articles = createResourceManifest(data.articles);
  const navigation = createResourceManifest(data.navigation);
  const settings = createResourceManifest(data.settings);

  return {
    version: MANIFEST_VERSION,
    schemaVersion: DATA_SCHEMA_VERSION,
    updatedAt: settings.updatedAt,
    resources: {
      articles,
      navigation,
      settings,
    },
  };
}

export function createBackupPayload(dataRoot, data, source = 'local') {
  return {
    version: BACKUP_VERSION,
    schemaVersion: DATA_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    persistent: isRuntimeDataRootWritableSync(dataRoot),
    dataRoot,
    manifest: createManifest(data),
    data: {
      articles: data.articles,
      navigation: data.navigation,
      settings: data.settings,
      ...(data.media ? { media: serializeBackupMedia(data.media) } : {}),
    },
  };
}

export function readBackupVersion(value) {
  if (!isRecord(value) || value.version === undefined) {
    return BACKUP_VERSION;
  }

  if (!Number.isInteger(value.version) || value.version < 1) {
    throw new Error('Backup version must be a positive integer.');
  }

  if (value.version > BACKUP_VERSION) {
    throw new Error(`Backup version ${value.version} is newer than supported ${BACKUP_VERSION}.`);
  }

  return value.version;
}

export function readSchemaVersion(value) {
  if (!isRecord(value) || value.schemaVersion === undefined) {
    return DATA_SCHEMA_VERSION;
  }

  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new Error('Backup schemaVersion must be a positive integer.');
  }

  if (value.schemaVersion > DATA_SCHEMA_VERSION) {
    throw new Error(`Backup schemaVersion ${value.schemaVersion} is newer than supported ${DATA_SCHEMA_VERSION}.`);
  }

  return value.schemaVersion;
}

export function migrateRuntimeData(data, fromSchemaVersion) {
  let currentData = data;
  let currentVersion = fromSchemaVersion;

  while (currentVersion < DATA_SCHEMA_VERSION) {
    const migration = DATA_MIGRATIONS.find((candidate) => candidate.from === currentVersion);

    if (!migration) {
      throw new Error(`Missing runtime data migration from schemaVersion ${currentVersion}.`);
    }

    currentData = migration.migrate(currentData);
    currentVersion = migration.to;
  }

  return currentData;
}

export function parseBackupPayloadData(value) {
  if (!isRecord(value)) {
    throw new Error('Backup file must contain a JSON object.');
  }

  if (isEncryptedBackupPayload(value)) {
    throw new Error('Encrypted backup payload detected. Use restore-encrypted-backup.mjs instead.');
  }

  readBackupVersion(value);
  const source = isRecord(value.data) ? value.data : value;

  if (!Array.isArray(source.articles) || !Array.isArray(source.navigation)) {
    throw new Error('Backup file must include articles and navigation arrays.');
  }

  return migrateRuntimeData(
    {
      articles: normalizeArticles(source.articles),
      navigation: normalizeNavigation(source.navigation),
      settings:
        source.settings === undefined
          ? createDefaultSiteSettings()
          : normalizeSiteSettings(source.settings),
      ...(source.media === undefined ? {} : { media: parseBackupMedia(source.media) }),
    },
    readSchemaVersion(value)
  );
}

export function readRuntimeData(dataRoot) {
  return {
    articles: normalizeArticles(readJsonArray(path.join(dataRoot, 'articles', 'articles.json'))),
    navigation: normalizeNavigation(readJsonArray(path.join(dataRoot, 'navigation', 'tools.json'))),
    settings: readSiteSettings(path.join(dataRoot, 'settings', 'site.json')),
  };
}

export function readRuntimeBackupData(dataRoot, options = {}) {
  return {
    ...readRuntimeData(dataRoot),
    media: readRuntimeBackupMedia(dataRoot, options.includeInlineMediaFiles !== false),
  };
}

export function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeRuntimeData(dataRoot, data) {
  writeJsonAtomically(path.join(dataRoot, 'articles', 'articles.json'), data.articles);
  writeJsonAtomically(path.join(dataRoot, 'navigation', 'tools.json'), data.navigation);
  writeJsonAtomically(path.join(dataRoot, 'settings', 'site.json'), data.settings);
}

export function writeManifest(dataRoot, manifest) {
  writeJsonAtomically(path.join(dataRoot, 'manifest.json'), manifest);
}

function createRestoreDirectory(dataRoot, name) {
  const directory = path.join(dataRoot, `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function getRuntimeDataFiles(dataRoot) {
  return [
    path.join(dataRoot, 'articles', 'articles.json'),
    path.join(dataRoot, 'navigation', 'tools.json'),
    path.join(dataRoot, 'settings', 'site.json'),
    path.join(dataRoot, 'manifest.json'),
  ];
}

function copyExistingFiles(files, fromRoot, toRoot) {
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const relativePath = path.relative(fromRoot, filePath);
    const backupPath = path.join(toRoot, relativePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(filePath, backupPath);
  }
}

function restoreFilesFromBackup(files, dataRoot, backupRoot) {
  for (const filePath of files) {
    const relativePath = path.relative(dataRoot, filePath);
    const backupPath = path.join(backupRoot, relativePath);

    if (!fs.existsSync(backupPath)) {
      fs.rmSync(filePath, { force: true });
      continue;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(backupPath, filePath);
  }
}

function replaceFilesFromStaging(files, dataRoot, stagingRoot) {
  for (const filePath of files) {
    const relativePath = path.relative(dataRoot, filePath);
    const stagedPath = path.join(stagingRoot, relativePath);

    if (!fs.existsSync(stagedPath)) {
      throw new Error(`Staged restore file is missing: ${relativePath}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.renameSync(stagedPath, filePath);
  }
}

function copyExistingDirectory(directoryPath, fromRoot, toRoot) {
  if (!fs.existsSync(directoryPath)) {
    return;
  }

  const relativePath = path.relative(fromRoot, directoryPath);
  const backupPath = path.join(toRoot, relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.cpSync(directoryPath, backupPath, { recursive: true });
}

function restoreDirectoryFromBackup(directoryPath, fromRoot, backupRoot) {
  const relativePath = path.relative(fromRoot, directoryPath);
  const backupPath = path.join(backupRoot, relativePath);

  fs.rmSync(directoryPath, { recursive: true, force: true });

  if (!fs.existsSync(backupPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(directoryPath), { recursive: true });
  fs.cpSync(backupPath, directoryPath, { recursive: true });
}

function replaceDirectoryFromStaging(directoryPath, fromRoot, stagingRoot) {
  const relativePath = path.relative(fromRoot, directoryPath);
  const stagedPath = path.join(stagingRoot, relativePath);

  if (!fs.existsSync(stagedPath)) {
    throw new Error(`Staged restore directory is missing: ${relativePath}`);
  }

  fs.rmSync(directoryPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(directoryPath), { recursive: true });
  fs.renameSync(stagedPath, directoryPath);
}

export function restoreRuntimeDataAtomically(dataRoot, data) {
  const normalizedData = {
    articles: normalizeArticles(data.articles),
    navigation: normalizeNavigation(data.navigation),
    settings: normalizeSiteSettings(data.settings),
  };
  const media = data.media;

  if (!hasRequiredInlineMediaFiles(media)) {
    throw new Error('Backup media files are missing or incomplete.');
  }

  const manifest = createManifest(normalizedData);
  const stagingRoot = createRestoreDirectory(dataRoot, '.restore-staging');
  const backupRoot = createRestoreDirectory(dataRoot, '.restore-backup');
  const files = getRuntimeDataFiles(dataRoot);
  const mediaRoot = getMediaRoot(dataRoot);
  let backupCaptured = false;

  try {
    writeRuntimeData(stagingRoot, normalizedData);
    writeManifest(stagingRoot, manifest);

    if (media) {
      writeRestoredMediaData(stagingRoot, media);
    }

    const stagedData = readRuntimeData(stagingRoot);
    const stagedManifest = readManifest(stagingRoot);
    const problems = getManifestProblems(stagedData, stagedManifest);

    if (problems.length > 0) {
      throw new Error(`Staged restore verification failed: ${problems.join('; ')}`);
    }

    copyExistingFiles(files, dataRoot, backupRoot);
    if (media) {
      copyExistingDirectory(mediaRoot, dataRoot, backupRoot);
    }
    backupCaptured = true;
    replaceFilesFromStaging(files, dataRoot, stagingRoot);
    if (media) {
      replaceDirectoryFromStaging(mediaRoot, dataRoot, stagingRoot);
    }

    return manifest;
  } catch (error) {
    if (backupCaptured) {
      restoreFilesFromBackup(files, dataRoot, backupRoot);
      if (media) {
        restoreDirectoryFromBackup(mediaRoot, dataRoot, backupRoot);
      }
    }

    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

export function readManifest(dataRoot) {
  const manifestPath = path.join(dataRoot, 'manifest.json');
  return fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
}

export function getManifestProblems(data, manifest) {
  const problems = [];

  if (!isRecord(manifest) || manifest.version !== MANIFEST_VERSION || !isRecord(manifest.resources)) {
    return ['manifest.json is missing or invalid.'];
  }

  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== DATA_SCHEMA_VERSION) {
    return [`manifest schemaVersion ${manifest.schemaVersion} is unsupported.`];
  }

  for (const resource of ['articles', 'navigation', 'settings']) {
    const resourceManifest = manifest.resources[resource];

    if (!isRecord(resourceManifest)) {
      problems.push(`${resource} manifest is missing.`);
      continue;
    }

    if (resourceManifest.hash !== hashJson(data[resource])) {
      problems.push(`${resource} hash does not match manifest.`);
    }
  }

  return problems;
}
