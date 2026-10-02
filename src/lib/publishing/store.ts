import fs from 'node:fs';
import path from 'node:path';
import type { Article } from '@/app/types/article';
import type { Category, Tool } from '@/app/types/navigation';
import { isRecord } from '@/lib/article-data';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { SITE_SETTING_KEYS } from '@/lib/site-settings';
import type {
  BackupProof,
  LivePointer,
  MediaRef,
  ReleaseRecord,
  ReleaseStatus,
  SiteSnapshot,
} from '@/lib/publishing/types';
import type { NavigationIdentityMap } from '@/lib/navigation-identities';

const RELEASE_STATUSES = new Set<ReleaseStatus>([
  'awaiting_backup', 'building', 'preview_ready', 'publishing', 'deploying',
  'verifying', 'live', 'failed', 'stale', 'cancelled',
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const ARTICLE_KEYS = new Set([
  'id', 'slug', 'title', 'date', 'description', 'tags', 'content', 'createdAt', 'updatedAt',
  'kind', 'status', 'category', 'series', 'featured', 'updatedDate', 'sourceLinks', 'revisionNotes', 'templateId',
]);
const CATEGORY_KEYS = new Set(['name', 'icon', 'slug', 'tools']);
const TOOL_KEYS = new Set(['icon', 'title', 'description', 'url', 'tags']);
const MEDIA_KEYS = new Set(['originalPath', 'publicPath', 'sha256', 'size', 'mimeType']);
const RELEASE_KEYS = new Set([
  'schemaVersion', 'id', 'scope', 'baseLiveReleaseId', 'selectedRevision', 'candidateDigest',
  'artifactDigest', 'status', 'backupProof', 'publicCommitSha', 'workflowRunId',
  'workflowRunAttempt', 'retryFromAttempt', 'error', 'createdAt', 'updatedAt',
]);
const LIVE_KEYS = new Set([
  'schemaVersion', 'releaseId', 'candidateDigest', 'artifactDigest', 'publicCommitSha',
  'workflowRunId', 'workflowRunAttempt', 'verifiedAt',
]);
const BACKUP_PROOF_KEYS = new Set([
  'repository', 'commitSha', 'snapshotId', 'contentDigest', 'candidateDigest', 'verifiedAt',
]);
const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'siteId', 'articles', 'navigation', 'settings', 'media', 'redirects', 'removedPaths',
]);
const NAVIGATION_KEYS = new Set(['schemaVersion', 'categories']);
const NAV_CATEGORY_KEYS = new Set(['id', 'slug', 'tools']);
const NAV_TOOL_KEYS = new Set(['id', 'normalizedUrl', 'groupOrder']);

export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(`UNSUPPORTED_SCHEMA: ${message}`);
    this.name = 'UnsupportedSchemaError';
  }
}

export class PublishingStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishingStoreValidationError';
  }
}

function workflowRoot(): string {
  return path.join(getRuntimeDataRootPath(), 'workflow');
}

function releaseDirectory(releaseId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(releaseId)) {
    throw new PublishingStoreValidationError('Invalid release ID.');
  }
  return path.join(workflowRoot(), 'releases', releaseId);
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new UnsupportedSchemaError(`${label} contains unsupported field(s): ${unsupported.join(', ')}`);
  }
}

function assertSchemaVersion(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) {
    throw new UnsupportedSchemaError(`${label} schemaVersion ${String(value.schemaVersion)} is unsupported.`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function validateArticle(value: unknown): value is Article {
  if (!isRecord(value)) return false;
  assertExactKeys(value, ARTICLE_KEYS, 'Article');

  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.date === 'string'
    && typeof value.description === 'string'
    && isStringArray(value.tags)
    && typeof value.content === 'string'
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && (value.slug === undefined || isString(value.slug))
    && (value.kind === undefined || isString(value.kind))
    && (value.status === undefined || isString(value.status))
    && (value.category === undefined || isString(value.category))
    && (value.series === undefined || isString(value.series))
    && (value.featured === undefined || typeof value.featured === 'boolean')
    && (value.updatedDate === undefined || isString(value.updatedDate))
    && (value.templateId === undefined || isString(value.templateId))
    && (value.sourceLinks === undefined || (Array.isArray(value.sourceLinks) && value.sourceLinks.every(isRecord)))
    && (value.revisionNotes === undefined || (Array.isArray(value.revisionNotes) && value.revisionNotes.every(isRecord)));
}

function validateTool(value: unknown): value is Tool {
  if (!isRecord(value)) return false;
  assertExactKeys(value, TOOL_KEYS, 'Navigation tool');
  return isString(value.icon) && isString(value.title) && isString(value.description)
    && isString(value.url) && isStringArray(value.tags);
}

function validateCategory(value: unknown): value is Category {
  if (!isRecord(value)) return false;
  assertExactKeys(value, CATEGORY_KEYS, 'Navigation category');
  return isString(value.name) && isString(value.icon) && isString(value.slug)
    && Array.isArray(value.tools) && value.tools.every(validateTool);
}

function validateMedia(value: unknown): value is MediaRef {
  if (!isRecord(value)) return false;
  assertExactKeys(value, MEDIA_KEYS, 'Managed media reference');
  return isString(value.originalPath) && isString(value.publicPath)
    && DIGEST_PATTERN.test(String(value.sha256))
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    && isString(value.mimeType);
}

function validateSettings(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set<string>([...SITE_SETTING_KEYS, 'showIntroCard']);
  assertExactKeys(value, allowed, 'Site settings');
  return Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => key === 'showIntroCard' ? typeof value[key] === 'boolean' : isString(value[key]));
}

function validateSnapshot(value: unknown): value is SiteSnapshot {
  if (!isRecord(value)) return false;
  assertSchemaVersion(value, 'Site snapshot');
  assertExactKeys(value, SNAPSHOT_KEYS, 'Site snapshot');

  return isString(value.siteId)
    && Array.isArray(value.articles) && value.articles.every(validateArticle)
    && Array.isArray(value.navigation) && value.navigation.every(validateCategory)
    && validateSettings(value.settings)
    && Array.isArray(value.media) && value.media.every(validateMedia)
    && Array.isArray(value.redirects) && value.redirects.every((item) => isRecord(item)
      && Object.keys(item).every((key) => key === 'from' || key === 'to')
      && isString(item.from) && isString(item.to))
    && isStringArray(value.removedPaths);
}

function validateScope(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false;
  if (value.kind === 'article') {
    return Object.keys(value).every((key) => ['kind', 'articleId', 'action'].includes(key))
      && isString(value.articleId) && (value.action === 'publish' || value.action === 'withdraw');
  }
  if (value.kind === 'navigation' || value.kind === 'settings') {
    return Object.keys(value).length === 1;
  }
  if (value.kind === 'bootstrap') {
    return Object.keys(value).every((key) => key === 'kind' || key === 'articleIds') && isStringArray(value.articleIds);
  }
  return false;
}

function validateBackupProof(value: unknown): value is BackupProof | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  assertExactKeys(value, BACKUP_PROOF_KEYS, 'Backup proof');
  return isString(value.repository) && isString(value.commitSha) && isString(value.snapshotId)
    && DIGEST_PATTERN.test(String(value.contentDigest)) && DIGEST_PATTERN.test(String(value.candidateDigest))
    && isString(value.verifiedAt);
}

function validateRelease(value: unknown): value is ReleaseRecord {
  if (!isRecord(value)) return false;
  assertSchemaVersion(value, 'Release record');
  assertExactKeys(value, RELEASE_KEYS, 'Release record');

  if (!validateScope(value.scope) || !validateBackupProof(value.backupProof)) return false;
  const errorValue = value.error;
  const errorValid = errorValue === null || (isRecord(errorValue)
    && Object.keys(errorValue).every((key) => ['code', 'message', 'retryable'].includes(key))
    && Object.keys(errorValue).length === 3
    && isString(errorValue.code) && isString(errorValue.message) && typeof errorValue.retryable === 'boolean');

  return isString(value.id)
    && isNullableString(value.baseLiveReleaseId)
    && DIGEST_PATTERN.test(String(value.selectedRevision))
    && DIGEST_PATTERN.test(String(value.candidateDigest))
    && (value.artifactDigest === null || DIGEST_PATTERN.test(String(value.artifactDigest)))
    && RELEASE_STATUSES.has(value.status as ReleaseStatus)
    && isNullableString(value.publicCommitSha)
    && isNullableNumber(value.workflowRunId)
    && isNullableNumber(value.workflowRunAttempt)
    && isNullableNumber(value.retryFromAttempt)
    && errorValid
    && isString(value.createdAt)
    && isString(value.updatedAt);
}

function validateLivePointer(value: unknown): value is LivePointer {
  if (!isRecord(value)) return false;
  assertSchemaVersion(value, 'Live pointer');
  assertExactKeys(value, LIVE_KEYS, 'Live pointer');
  return isString(value.releaseId)
    && DIGEST_PATTERN.test(String(value.candidateDigest))
    && DIGEST_PATTERN.test(String(value.artifactDigest))
    && SHA_PATTERN.test(String(value.publicCommitSha))
    && typeof value.workflowRunId === 'number' && Number.isSafeInteger(value.workflowRunId) && value.workflowRunId > 0
    && typeof value.workflowRunAttempt === 'number' && Number.isSafeInteger(value.workflowRunAttempt) && value.workflowRunAttempt > 0
    && isString(value.verifiedAt);
}

function validateNavigationIdentityMap(value: unknown): value is NavigationIdentityMap {
  if (!isRecord(value)) return false;
  assertSchemaVersion(value, 'Navigation identity map');
  assertExactKeys(value, NAVIGATION_KEYS, 'Navigation identity map');
  return Array.isArray(value.categories) && value.categories.every((category) => {
    if (!isRecord(category)) return false;
    assertExactKeys(category, NAV_CATEGORY_KEYS, 'Navigation category identity');
    return isString(category.id) && isString(category.slug) && Array.isArray(category.tools)
      && category.tools.every((tool) => {
        if (!isRecord(tool)) return false;
        assertExactKeys(tool, NAV_TOOL_KEYS, 'Navigation tool identity');
        return isString(tool.id) && isString(tool.normalizedUrl)
          && typeof tool.groupOrder === 'number' && Number.isSafeInteger(tool.groupOrder) && tool.groupOrder >= 0;
      });
  });
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

export function writeRelease(release: ReleaseRecord, snapshot: SiteSnapshot): void {
  const directory = releaseDirectory(release.id);
  if (!validateRelease(release) || !validateSnapshot(snapshot)) {
    throw new PublishingStoreValidationError('Release record or snapshot is invalid.');
  }
  if (snapshot.schemaVersion !== 1) {
    throw new UnsupportedSchemaError('Site snapshot schemaVersion is unsupported.');
  }

  fs.mkdirSync(directory, { recursive: true });
  writeJsonAtomically(path.join(directory, 'snapshot.json'), snapshot);
  writeJsonAtomically(path.join(directory, 'release.json'), release);
}

export function readRelease(releaseId: string): { release: ReleaseRecord; snapshot: SiteSnapshot } {
  const directory = releaseDirectory(releaseId);
  const release = readJson(path.join(directory, 'release.json'));
  const snapshot = readJson(path.join(directory, 'snapshot.json'));

  if (!validateRelease(release) || !validateSnapshot(snapshot)) {
    throw new PublishingStoreValidationError('Stored release record or snapshot is invalid.');
  }
  if (release.id !== releaseId) {
    throw new PublishingStoreValidationError('Stored release ID does not match its directory.');
  }

  return { release, snapshot };
}

export function writeLivePointer(pointer: LivePointer): void {
  if (!validateLivePointer(pointer)) {
    throw new PublishingStoreValidationError('Live pointer is invalid.');
  }
  releaseDirectory(pointer.releaseId);
  writeJsonAtomically(path.join(workflowRoot(), 'live.json'), pointer);
}

export function readLivePointer(): LivePointer | null {
  const filePath = path.join(workflowRoot(), 'live.json');
  if (!fs.existsSync(filePath)) return null;

  const pointer = readJson(filePath);
  if (!validateLivePointer(pointer)) {
    throw new PublishingStoreValidationError('Stored live pointer is invalid.');
  }
  return pointer;
}

export function writeNavigationIdentities(identities: NavigationIdentityMap): void {
  if (!validateNavigationIdentityMap(identities)) {
    throw new PublishingStoreValidationError('Navigation identity map is invalid.');
  }
  writeJsonAtomically(path.join(workflowRoot(), 'navigation-identities.json'), identities);
}

export function readNavigationIdentities(): NavigationIdentityMap | null {
  const filePath = path.join(workflowRoot(), 'navigation-identities.json');
  if (!fs.existsSync(filePath)) return null;
  const identities = readJson(filePath);

  if (!validateNavigationIdentityMap(identities)) {
    throw new PublishingStoreValidationError('Stored navigation identity map is invalid.');
  }
  return identities;
}

export function parseStoredRelease(value: unknown): ReleaseRecord {
  if (!validateRelease(value)) {
    throw new PublishingStoreValidationError('Release record is invalid.');
  }
  return value;
}

export function isKnownReleaseStatus(value: unknown): value is ReleaseStatus {
  return typeof value === 'string' && RELEASE_STATUSES.has(value as ReleaseStatus);
}
