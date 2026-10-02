import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { EditorDataManifest } from '@/lib/editor-data-storage';
import type { EditorMediaManifest, EditorMediaMimeType } from '@/lib/editor-media-storage';
import type { SiteSettings } from '@/lib/site-settings';
import { isRecord } from '@/lib/article-data';

export const R2_CHUNKED_BACKUP_SCHEMA_VERSION = 2;
export const R2_CHUNKED_BACKUP_FORMAT = 'v2-chunked';

export interface R2ChunkedObjectReference {
    key: string;
    sha256: string;
    size: number;
}

export interface R2ChunkedIndexedReference extends R2ChunkedObjectReference {
    count: number;
}

export interface R2ChunkedRepository {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'repository';
    name: 'blog-navigation-r2-backup';
    createdAt: string;
    format: 'chunked-json';
    features: {
        articleObjects: true;
        mediaObjects: true;
        contentAddressed: true;
    };
}

export interface R2ChunkedLatestPointer {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'latest-pointer';
    updatedAt: string;
    snapshotId: string;
    snapshotKey: string;
    snapshotHash: string;
}

export interface R2ChunkedSnapshotManifest {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'snapshot';
    snapshotId: string;
    createdAt: string;
    reason: string;
    source: 'r2';
    persistent: boolean;
    dataManifest?: EditorDataManifest;
    counts: {
        articles: number;
        categories: number;
        media: number;
    };
    articleIndexes: R2ChunkedIndexedReference[];
    mediaIndexes: R2ChunkedIndexedReference[];
    navigation: R2ChunkedObjectReference;
    settings: R2ChunkedObjectReference;
    mediaManifest: R2ChunkedObjectReference;
}

export interface R2ChunkedArticleIndexItem extends R2ChunkedObjectReference {
    id: string;
}

export interface R2ChunkedArticleIndex {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'article-index';
    snapshotId: string;
    page: number;
    items: R2ChunkedArticleIndexItem[];
}

export interface R2ChunkedMediaIndexItem extends R2ChunkedObjectReference {
    path: string;
    publicPath: string;
    mimeType: EditorMediaMimeType;
}

export interface R2ChunkedMediaIndex {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'media-index';
    snapshotId: string;
    page: number;
    items: R2ChunkedMediaIndexItem[];
}

export interface R2ChunkedArticleObject {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'article';
    id: string;
    data: Article;
}

export interface R2ChunkedNavigationObject {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'navigation';
    data: Category[];
}

export interface R2ChunkedSettingsObject {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'settings';
    data: SiteSettings;
}

export interface R2ChunkedMediaManifestObject {
    schemaVersion: typeof R2_CHUNKED_BACKUP_SCHEMA_VERSION;
    kind: 'media-manifest';
    data: EditorMediaManifest;
}

function isHexSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isSafeRelativeR2Key(value: unknown): value is string {
    return (
        isNonEmptyString(value) &&
        value.startsWith('v2/') &&
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value.split('/').includes('..')
    );
}

function isSnapshotManifestKey(value: unknown): value is string {
    return (
        isSafeRelativeR2Key(value) &&
        value.startsWith('v2/snapshots/') &&
        value.endsWith('/manifest.json')
    );
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isObjectReference(value: unknown): value is R2ChunkedObjectReference {
    return (
        isRecord(value) &&
        isSafeRelativeR2Key(value.key) &&
        isHexSha256(value.sha256) &&
        isPositiveInteger(value.size)
    );
}

function isIndexedReference(value: unknown): value is R2ChunkedIndexedReference {
    return isObjectReference(value) && isRecord(value) && isPositiveInteger(value.count);
}

function isMediaMimeType(value: unknown): value is EditorMediaMimeType {
    return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}

export function parseR2ChunkedLatestPointer(value: unknown): R2ChunkedLatestPointer | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'latest-pointer' ||
        !isNonEmptyString(value.updatedAt) ||
        !isNonEmptyString(value.snapshotId) ||
        !isSnapshotManifestKey(value.snapshotKey) ||
        !isHexSha256(value.snapshotHash)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedLatestPointer;
}

export function parseR2ChunkedSnapshotManifest(value: unknown): R2ChunkedSnapshotManifest | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'snapshot' ||
        !isNonEmptyString(value.snapshotId) ||
        !isNonEmptyString(value.createdAt) ||
        !isNonEmptyString(value.reason) ||
        value.source !== 'r2' ||
        typeof value.persistent !== 'boolean' ||
        !isRecord(value.counts) ||
        !isPositiveInteger(value.counts.articles) ||
        !isPositiveInteger(value.counts.categories) ||
        !isPositiveInteger(value.counts.media) ||
        !Array.isArray(value.articleIndexes) ||
        !value.articleIndexes.every(isIndexedReference) ||
        !Array.isArray(value.mediaIndexes) ||
        !value.mediaIndexes.every(isIndexedReference) ||
        !isObjectReference(value.navigation) ||
        !isObjectReference(value.settings) ||
        !isObjectReference(value.mediaManifest)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedSnapshotManifest;
}

export function parseR2ChunkedArticleIndex(value: unknown, snapshotId: string): R2ChunkedArticleIndex | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'article-index' ||
        value.snapshotId !== snapshotId ||
        !isPositiveInteger(value.page) ||
        !Array.isArray(value.items)
    ) {
        return null;
    }

    for (const item of value.items) {
        if (!isRecord(item) || !isNonEmptyString(item.id) || !isObjectReference(item)) {
            return null;
        }
    }

    return value as unknown as R2ChunkedArticleIndex;
}

export function parseR2ChunkedMediaIndex(value: unknown, snapshotId: string): R2ChunkedMediaIndex | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'media-index' ||
        value.snapshotId !== snapshotId ||
        !isPositiveInteger(value.page) ||
        !Array.isArray(value.items)
    ) {
        return null;
    }

    for (const item of value.items) {
        if (
            !isRecord(item) ||
            !isNonEmptyString(item.path) ||
            !isNonEmptyString(item.publicPath) ||
            !isMediaMimeType(item.mimeType) ||
            !isObjectReference(item)
        ) {
            return null;
        }
    }

    return value as unknown as R2ChunkedMediaIndex;
}

export function parseR2ChunkedArticleObject(value: unknown): R2ChunkedArticleObject | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'article' ||
        !isNonEmptyString(value.id) ||
        !isRecord(value.data)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedArticleObject;
}

export function parseR2ChunkedNavigationObject(value: unknown): R2ChunkedNavigationObject | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'navigation' ||
        !Array.isArray(value.data)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedNavigationObject;
}

export function parseR2ChunkedSettingsObject(value: unknown): R2ChunkedSettingsObject | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'settings' ||
        !isRecord(value.data)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedSettingsObject;
}

export function parseR2ChunkedMediaManifestObject(value: unknown): R2ChunkedMediaManifestObject | null {
    if (
        !isRecord(value) ||
        value.schemaVersion !== R2_CHUNKED_BACKUP_SCHEMA_VERSION ||
        value.kind !== 'media-manifest' ||
        !isRecord(value.data)
    ) {
        return null;
    }

    return value as unknown as R2ChunkedMediaManifestObject;
}
