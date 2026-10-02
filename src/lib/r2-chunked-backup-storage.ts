import {
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Article } from '@/app/types/article';
import {
    isRecord,
    parseArticlesDataOrThrow,
} from '@/lib/article-data';
import type {
    CurrentEditorRemoteBackupPackage,
    EditorBackupData,
} from '@/lib/editor-data-backup';
import {
    EditorMediaRestoreDownloadError,
    type EditorMediaRestoreResult,
} from '@/lib/editor-media-remote';
import {
    EDITOR_MEDIA_MAX_IMAGE_BYTES,
    parseEditorMediaManifest,
    type EditorMediaManifest,
    type EditorMediaMimeType,
} from '@/lib/editor-media-storage';
import { parseNavigationDataOrThrow } from '@/lib/navigation-data';
import {
    bodyToBytes,
    bodyToString,
    createR2Client,
    getR2BackupConfig,
    joinR2Key,
    R2BackupNotConfiguredError,
    R2BackupPayloadTooLargeError,
    type R2BackupConfig,
} from '@/lib/r2-backup-storage';
import {
    createR2ChunkedArticleIndexKey,
    createR2ChunkedArticleObjectKey,
    createR2ChunkedLatestPointerKey,
    createR2ChunkedMediaIndexKey,
    createR2ChunkedMediaManifestObjectKey,
    createR2ChunkedMediaObjectKey,
    createR2ChunkedNavigationObjectKey,
    createR2ChunkedRepositoryKey,
    createR2ChunkedSettingsObjectKey,
    createR2ChunkedSnapshotId,
    createR2ChunkedSnapshotManifestKey,
    createR2ChunkedSnapshotRootKey,
    resolveR2ChunkedKey,
} from '@/lib/r2-chunked-backup-keys';
import {
    isR2ChunkedUploadCacheHit,
    readR2ChunkedUploadCache,
    rememberR2ChunkedUploadedObject,
    writeR2ChunkedUploadCache,
} from '@/lib/r2-chunked-backup-cache';
import {
    parseR2ChunkedArticleIndex,
    parseR2ChunkedArticleObject,
    parseR2ChunkedLatestPointer,
    parseR2ChunkedMediaIndex,
    parseR2ChunkedMediaManifestObject,
    parseR2ChunkedNavigationObject,
    parseR2ChunkedSettingsObject,
    parseR2ChunkedSnapshotManifest,
    R2_CHUNKED_BACKUP_FORMAT,
    R2_CHUNKED_BACKUP_SCHEMA_VERSION,
    type R2ChunkedArticleIndex,
    type R2ChunkedArticleIndexItem,
    type R2ChunkedMediaIndex,
    type R2ChunkedMediaIndexItem,
    type R2ChunkedObjectReference,
    type R2ChunkedRepository,
    type R2ChunkedLatestPointer,
    type R2ChunkedSnapshotManifest,
} from '@/lib/r2-chunked-backup-types';
import { parseSiteSettingsOrThrow } from '@/lib/site-settings';
import {
    sha256Hex,
    stableJsonStringify,
} from '@/lib/stable-json';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const ARTICLE_INDEX_MAX_ITEMS = 1000;
const MEDIA_INDEX_MAX_ITEMS = 1000;
const INDEX_MAX_BYTES = 1024 * 1024;

type S3ClientLike = ReturnType<typeof createR2Client>;

interface PreparedJsonObject<T> {
    value: T;
    body: string;
    reference: R2ChunkedObjectReference;
}

interface PreparedMediaObject {
    key: string;
    sha256: string;
    size: number;
    mimeType: EditorMediaMimeType;
    bytes: Uint8Array;
}

export interface R2ChunkedUploadResult {
    format: typeof R2_CHUNKED_BACKUP_FORMAT;
    latestKey: string | null;
    snapshotKey: string | null;
    snapshotId: string;
    counts: {
        articles: number;
        categories: number;
        media: number;
    };
}

export interface R2ChunkedRestorePackage {
    format: typeof R2_CHUNKED_BACKUP_FORMAT;
    snapshotId: string;
    data: EditorBackupData;
    mediaRestore: EditorMediaRestoreResult;
}

export class R2ChunkedBackupNotFoundError extends Error {
    constructor(message = 'R2 chunked backup was not found.') {
        super(message);
        this.name = 'R2ChunkedBackupNotFoundError';
    }
}

export class R2ChunkedBackupFormatError extends Error {
    constructor(
        message: string,
        public readonly stage: string,
        public readonly key?: string
    ) {
        super(message);
        this.name = 'R2ChunkedBackupFormatError';
    }
}

export class R2ChunkedBackupIntegrityError extends Error {
    constructor(
        message: string,
        public readonly stage: string,
        public readonly key?: string
    ) {
        super(message);
        this.name = 'R2ChunkedBackupIntegrityError';
    }
}

export class R2ChunkedBackupObjectMissingError extends Error {
    constructor(
        message: string,
        public readonly stage: string,
        public readonly key: string
    ) {
        super(message);
        this.name = 'R2ChunkedBackupObjectMissingError';
    }
}

function isNoSuchKeyError(error: unknown): boolean {
    return (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata.httpStatusCode === 404)
    );
}

function createFullKey(config: R2BackupConfig, relativeKey: string): string {
    return resolveR2ChunkedKey(config, relativeKey);
}

function parseJsonText(text: string, stage: string, key: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new R2ChunkedBackupFormatError('R2 v2 backup object is not valid JSON.', stage, key);
    }
}

function assertHashAndSize(
    text: string,
    reference: R2ChunkedObjectReference,
    stage: string
): void {
    const size = Buffer.byteLength(text, 'utf8');

    if (size !== reference.size) {
        throw new R2ChunkedBackupIntegrityError('R2 v2 JSON object size mismatch.', stage, reference.key);
    }

    if (sha256Hex(text) !== reference.sha256) {
        throw new R2ChunkedBackupIntegrityError('R2 v2 JSON object hash mismatch.', stage, reference.key);
    }
}

function createJsonObject<T>(key: string, value: T): PreparedJsonObject<T> {
    const body = stableJsonStringify(value);

    return {
        value,
        body,
        reference: {
            key,
            sha256: sha256Hex(body),
            size: Buffer.byteLength(body, 'utf8'),
        },
    };
}

async function putJsonObject(
    client: S3ClientLike,
    config: R2BackupConfig,
    object: PreparedJsonObject<unknown>
): Promise<void> {
    await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: createFullKey(config, object.reference.key),
        Body: object.body,
        ContentType: JSON_CONTENT_TYPE,
    }));
}

async function readLatestPointerForUpdate(
    client: S3ClientLike,
    config: R2BackupConfig
): Promise<{ pointer: R2ChunkedLatestPointer; etag: string } | null> {
    const key = createR2ChunkedLatestPointerKey();

    try {
        const response = await client.send(new GetObjectCommand({
            Bucket: config.bucket,
            Key: createFullKey(config, key),
        }));
        const etag = response.ETag;
        if (typeof etag !== 'string' || !etag) {
            throw new R2ChunkedBackupIntegrityError('R2 latest pointer has no ETag.', 'write-latest', key);
        }
        const text = await bodyToString(response.Body);
        const pointer = parseR2ChunkedLatestPointer(parseJsonText(text, 'write-latest', key));
        if (!pointer) {
            throw new R2ChunkedBackupFormatError('R2 v2 latest pointer format is invalid.', 'write-latest', key);
        }
        return { pointer, etag };
    } catch (error) {
        if (isNoSuchKeyError(error)) return null;
        throw error;
    }
}

function isConditionalWriteConflict(error: unknown): boolean {
    return error instanceof S3ServiceException && (
        error.$metadata.httpStatusCode === 409 ||
        error.$metadata.httpStatusCode === 412 ||
        error.name === 'PreconditionFailed' ||
        error.name === 'ConditionalRequestConflict'
    );
}

async function writeLatestPointerConditionally(
    client: S3ClientLike,
    config: R2BackupConfig,
    object: PreparedJsonObject<R2ChunkedLatestPointer>
): Promise<void> {
    const latestKey = createFullKey(config, object.reference.key);

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await readLatestPointerForUpdate(client, config);
        if (current && (
            current.pointer.updatedAt > object.value.updatedAt ||
            (current.pointer.updatedAt === object.value.updatedAt && current.pointer.snapshotId >= object.value.snapshotId)
        )) return;

        try {
            await client.send(new PutObjectCommand({
                Bucket: config.bucket,
                Key: latestKey,
                Body: object.body,
                ContentType: JSON_CONTENT_TYPE,
                ...(current ? { IfMatch: current.etag } : { IfNoneMatch: '*' }),
            }));
            return;
        } catch (error) {
            if (!isConditionalWriteConflict(error) || attempt === 4) throw error;
        }
    }
}

async function putMediaObject(
    client: S3ClientLike,
    config: R2BackupConfig,
    object: PreparedMediaObject
): Promise<void> {
    await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: createFullKey(config, object.key),
        Body: Buffer.from(object.bytes),
        ContentType: object.mimeType,
    }));
}

async function getObjectText(
    client: S3ClientLike,
    config: R2BackupConfig,
    relativeKey: string,
    stage: string
): Promise<string> {
    const key = createFullKey(config, relativeKey);

    try {
        const response = await client.send(new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
        }));

        return await bodyToString(response.Body);
    } catch (error) {
        if (isNoSuchKeyError(error)) {
            throw new R2ChunkedBackupObjectMissingError('R2 v2 backup object is missing.', stage, relativeKey);
        }

        throw error;
    }
}

async function getVerifiedJson<T>(
    client: S3ClientLike,
    config: R2BackupConfig,
    reference: R2ChunkedObjectReference,
    stage: string,
    parse: (value: unknown) => T | null
): Promise<T> {
    const text = await getObjectText(client, config, reference.key, stage);
    assertHashAndSize(text, reference, stage);

    const parsed = parse(parseJsonText(text, stage, reference.key));

    if (!parsed) {
        throw new R2ChunkedBackupFormatError('R2 v2 backup object format is invalid.', stage, reference.key);
    }

    return parsed;
}

function readPayloadMediaManifest(value: unknown): EditorMediaManifest {
    if (value === undefined) {
        return {
            version: 1,
            updatedAt: new Date().toISOString(),
            assets: [],
        };
    }

    const legacyManifest = parseEditorMediaManifest(value);

    if (legacyManifest) {
        return legacyManifest;
    }

    if (!isRecord(value)) {
        throw new R2ChunkedBackupFormatError('Backup media payload is invalid.', 'prepare-media-manifest');
    }

    const manifest = parseEditorMediaManifest(value.manifest);

    if (!manifest) {
        throw new R2ChunkedBackupFormatError('Backup media manifest is invalid.', 'prepare-media-manifest');
    }

    return manifest;
}

function createMediaBytesByPath(backupPackage: CurrentEditorRemoteBackupPackage): Map<string, Uint8Array> {
    return new Map(backupPackage.mediaAssets.map((mediaAsset) => [
        mediaAsset.asset.path,
        mediaAsset.bytes,
    ]));
}

function createMediaObject(
    asset: EditorMediaManifest['assets'][number],
    bytes: Uint8Array
): PreparedMediaObject {
    const hash = sha256Hex(bytes);

    if (hash !== asset.hash || bytes.byteLength !== asset.size) {
        throw new R2ChunkedBackupIntegrityError('Local media file does not match its manifest.', 'prepare-media', asset.path);
    }

    return {
        key: createR2ChunkedMediaObjectKey(asset.hash, asset.mimeType),
        sha256: asset.hash,
        size: asset.size,
        mimeType: asset.mimeType,
        bytes,
    };
}

function createArticleObjects(articles: Article[]): Array<PreparedJsonObject<unknown> & { id: string }> {
    return articles.map((article) => {
        const value = {
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'article' as const,
            id: article.id,
            data: article,
        };
        const body = stableJsonStringify(value);
        const hash = sha256Hex(body);

        return {
            value,
            body,
            id: article.id,
            reference: {
                key: createR2ChunkedArticleObjectKey(article.id, hash),
                sha256: hash,
                size: Buffer.byteLength(body, 'utf8'),
            },
        };
    });
}

function createIndexPages<TItem, TPage>(
    items: TItem[],
    maxItems: number,
    createPage: (page: number, pageItems: TItem[]) => TPage
): Array<PreparedJsonObject<TPage> & { count: number }> {
    const pages: Array<PreparedJsonObject<TPage> & { count: number }> = [];
    let current: TItem[] = [];

    for (const item of items) {
        const candidate = [...current, item];
        const candidateText = stableJsonStringify(createPage(pages.length, candidate));
        const exceedsSize = Buffer.byteLength(candidateText, 'utf8') > INDEX_MAX_BYTES;

        if (current.length > 0 && (current.length >= maxItems || exceedsSize)) {
            const page = createJsonObject('', createPage(pages.length, current));
            pages.push({
                ...page,
                count: current.length,
            });
            current = [item];
        } else {
            current = candidate;
        }
    }

    if (current.length > 0 || items.length === 0) {
        const page = createJsonObject('', createPage(pages.length, current));
        pages.push({
            ...page,
            count: current.length,
        });
    }

    return pages;
}

function withReferenceKey<TObject extends PreparedJsonObject<unknown>>(
    object: TObject,
    key: string
): TObject {
    return {
        ...object,
        reference: {
            ...object.reference,
            key,
        },
    } as TObject;
}

function createRepositoryObject(now: Date): PreparedJsonObject<R2ChunkedRepository> {
    return createJsonObject(createR2ChunkedRepositoryKey(), {
        schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
        kind: 'repository',
        name: 'blog-navigation-r2-backup',
        createdAt: now.toISOString(),
        format: 'chunked-json',
        features: {
            articleObjects: true,
            mediaObjects: true,
            contentAddressed: true,
        },
    });
}

async function putCachedJsonObject(
    client: S3ClientLike,
    config: R2BackupConfig,
    object: PreparedJsonObject<unknown>,
    cache: ReturnType<typeof readR2ChunkedUploadCache>
): Promise<void> {
    const fullKey = createFullKey(config, object.reference.key);

    if (
        isR2ChunkedUploadCacheHit(cache, fullKey, object.reference.sha256, object.reference.size) &&
        await isRemoteObjectPresent(client, config, fullKey, object.reference.size)
    ) {
        return;
    }

    await putJsonObject(client, config, object);
    rememberR2ChunkedUploadedObject(cache, fullKey, object.reference.sha256, object.reference.size);
}

async function putCachedMediaObject(
    client: S3ClientLike,
    config: R2BackupConfig,
    object: PreparedMediaObject,
    cache: ReturnType<typeof readR2ChunkedUploadCache>
): Promise<void> {
    const fullKey = createFullKey(config, object.key);

    if (
        isR2ChunkedUploadCacheHit(cache, fullKey, object.sha256, object.size) &&
        await isRemoteObjectPresent(client, config, fullKey, object.size)
    ) {
        return;
    }

    await putMediaObject(client, config, object);
    rememberR2ChunkedUploadedObject(cache, fullKey, object.sha256, object.size);
}

async function isRemoteObjectPresent(
    client: S3ClientLike,
    config: R2BackupConfig,
    fullKey: string,
    expectedSize: number
): Promise<boolean> {
    try {
        const response = await client.send(new HeadObjectCommand({
            Bucket: config.bucket,
            Key: fullKey,
        }));

        return response.ContentLength === expectedSize;
    } catch (error) {
        if (isNoSuchKeyError(error)) {
            return false;
        }

        throw error;
    }
}

export async function uploadChunkedBackupToR2(
    backupPackage: CurrentEditorRemoteBackupPackage,
    options: {
        reason: string;
        writeSnapshot: boolean;
        writeLatest?: boolean;
    }
): Promise<R2ChunkedUploadResult> {
    const config = getR2BackupConfig();

    if (!config) {
        throw new R2BackupNotConfiguredError();
    }

    const writeLatest = options.writeLatest ?? true;

    if (!writeLatest && !options.writeSnapshot) {
        throw new Error('R2 v2 backup upload must write latest or a snapshot.');
    }

    const now = new Date();
    const snapshotId = createR2ChunkedSnapshotId(now);
    const snapshotRootKey = createR2ChunkedSnapshotRootKey(snapshotId, now);
    const snapshotKey = createR2ChunkedSnapshotManifestKey(snapshotRootKey);
    const client = createR2Client(config);
    const payload = backupPackage.payload;
    const mediaManifest = readPayloadMediaManifest(payload.data.media);
    const mediaBytesByPath = createMediaBytesByPath(backupPackage);
    const articleObjects = createArticleObjects(payload.data.articles);
    const navigationObject = createJsonObject(
        createR2ChunkedNavigationObjectKey(sha256Hex(stableJsonStringify({
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'navigation',
            data: payload.data.navigation,
        }))),
        {
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'navigation' as const,
            data: payload.data.navigation,
        }
    );
    const settingsObject = createJsonObject(
        createR2ChunkedSettingsObjectKey(sha256Hex(stableJsonStringify({
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'settings',
            data: payload.data.settings,
        }))),
        {
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'settings' as const,
            data: payload.data.settings,
        }
    );
    const mediaManifestObject = createJsonObject(
        createR2ChunkedMediaManifestObjectKey(sha256Hex(stableJsonStringify({
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'media-manifest',
            data: mediaManifest,
        }))),
        {
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'media-manifest' as const,
            data: mediaManifest,
        }
    );
    const mediaObjects = mediaManifest.assets.map((asset) => {
        const bytes = mediaBytesByPath.get(asset.path);

        if (!bytes) {
            throw new R2ChunkedBackupIntegrityError('Missing local media file for R2 v2 backup.', 'prepare-media', asset.path);
        }

        return createMediaObject(asset, bytes);
    });
    const articleItems: R2ChunkedArticleIndexItem[] = articleObjects.map((object) => ({
        id: object.id,
        ...object.reference,
    }));
    const mediaItems: R2ChunkedMediaIndexItem[] = mediaManifest.assets.map((asset) => ({
        path: asset.path,
        publicPath: asset.publicPath,
        key: createR2ChunkedMediaObjectKey(asset.hash, asset.mimeType),
        sha256: asset.hash,
        size: asset.size,
        mimeType: asset.mimeType,
    }));
    const articleIndexObjects = createIndexPages(
        articleItems,
        ARTICLE_INDEX_MAX_ITEMS,
        (page, items): R2ChunkedArticleIndex => ({
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'article-index',
            snapshotId,
            page,
            items,
        })
    ).map((object, index) => withReferenceKey(object, createR2ChunkedArticleIndexKey(snapshotRootKey, index)));
    const mediaIndexObjects = createIndexPages(
        mediaItems,
        MEDIA_INDEX_MAX_ITEMS,
        (page, items): R2ChunkedMediaIndex => ({
            schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
            kind: 'media-index',
            snapshotId,
            page,
            items,
        })
    ).map((object, index) => withReferenceKey(object, createR2ChunkedMediaIndexKey(snapshotRootKey, index)));
    const snapshotManifest: R2ChunkedSnapshotManifest = {
        schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
        kind: 'snapshot',
        snapshotId,
        createdAt: now.toISOString(),
        reason: options.reason,
        source: 'r2',
        persistent: payload.persistent,
        ...(payload.manifest ? { dataManifest: payload.manifest } : {}),
        counts: {
            articles: payload.data.articles.length,
            categories: payload.data.navigation.length,
            media: mediaManifest.assets.length,
        },
        articleIndexes: articleIndexObjects.map((object) => ({
            ...object.reference,
            count: object.count,
        })),
        mediaIndexes: mediaIndexObjects.map((object) => ({
            ...object.reference,
            count: object.count,
        })),
        navigation: navigationObject.reference,
        settings: settingsObject.reference,
        mediaManifest: mediaManifestObject.reference,
    };
    const snapshotObject = createJsonObject(snapshotKey, snapshotManifest);
    const latestObject = createJsonObject<R2ChunkedLatestPointer>(createR2ChunkedLatestPointerKey(), {
        schemaVersion: R2_CHUNKED_BACKUP_SCHEMA_VERSION,
        kind: 'latest-pointer' as const,
        updatedAt: now.toISOString(),
        snapshotId,
        snapshotKey,
        snapshotHash: snapshotObject.reference.sha256,
    });
    const cache = readR2ChunkedUploadCache();

    await putCachedJsonObject(client, config, createRepositoryObject(now), cache);

    for (const object of [...articleObjects, navigationObject, settingsObject, mediaManifestObject]) {
        await putCachedJsonObject(client, config, object, cache);
    }

    for (const object of mediaObjects) {
        await putCachedMediaObject(client, config, object, cache);
    }

    writeR2ChunkedUploadCache(cache);

    for (const object of [...articleIndexObjects, ...mediaIndexObjects]) {
        await putJsonObject(client, config, object);
    }

    await putJsonObject(client, config, snapshotObject);

    if (writeLatest) {
        await writeLatestPointerConditionally(client, config, latestObject);
    }

    return {
        format: R2_CHUNKED_BACKUP_FORMAT,
        latestKey: writeLatest ? createFullKey(config, latestObject.reference.key) : null,
        snapshotKey: createFullKey(config, snapshotKey),
        snapshotId,
        counts: snapshotManifest.counts,
    };
}

async function readLatestPointer(
    client: S3ClientLike,
    config: R2BackupConfig
) {
    const relativeKey = createR2ChunkedLatestPointerKey();

    try {
        const text = await getObjectText(client, config, relativeKey, 'read-latest');
        const pointer = parseR2ChunkedLatestPointer(parseJsonText(text, 'read-latest', relativeKey));

        if (!pointer) {
            throw new R2ChunkedBackupFormatError('R2 v2 latest pointer format is invalid.', 'read-latest', relativeKey);
        }

        return pointer;
    } catch (error) {
        if (error instanceof R2ChunkedBackupObjectMissingError) {
            throw new R2ChunkedBackupNotFoundError(`R2 v2 latest pointer was not found at ${relativeKey}.`);
        }

        throw error;
    }
}

async function readSnapshotManifest(
    client: S3ClientLike,
    config: R2BackupConfig,
    snapshotKey: string,
    snapshotHash: string
): Promise<R2ChunkedSnapshotManifest> {
    const text = await getObjectText(client, config, snapshotKey, 'read-snapshot');

    if (sha256Hex(text) !== snapshotHash) {
        throw new R2ChunkedBackupIntegrityError('R2 v2 snapshot hash mismatch.', 'read-snapshot', snapshotKey);
    }

    const snapshot = parseR2ChunkedSnapshotManifest(parseJsonText(text, 'read-snapshot', snapshotKey));

    if (!snapshot) {
        throw new R2ChunkedBackupFormatError('R2 v2 snapshot format is invalid.', 'read-snapshot', snapshotKey);
    }

    return snapshot;
}

async function readMediaObject(
    client: S3ClientLike,
    config: R2BackupConfig,
    item: R2ChunkedMediaIndexItem,
    result: EditorMediaRestoreResult
): Promise<{ path: string; bytes: Uint8Array }> {
    try {
        const response = await client.send(new GetObjectCommand({
            Bucket: config.bucket,
            Key: createFullKey(config, item.key),
        }));

        if (typeof response.ContentLength === 'number' && response.ContentLength > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
            throw new R2BackupPayloadTooLargeError(EDITOR_MEDIA_MAX_IMAGE_BYTES);
        }

        if (response.ContentType && response.ContentType !== item.mimeType) {
            throw new R2ChunkedBackupIntegrityError('R2 v2 media object content type mismatch.', 'read-media-object', item.key);
        }

        const bytes = await bodyToBytes(response.Body, EDITOR_MEDIA_MAX_IMAGE_BYTES);

        if (bytes.byteLength !== item.size || sha256Hex(bytes) !== item.sha256) {
            throw new R2ChunkedBackupIntegrityError('R2 v2 media object hash mismatch.', 'read-media-object', item.key);
        }

        result.restored += 1;

        return {
            path: item.path,
            bytes,
        };
    } catch (error) {
        result.failed += 1;
        result.failures.push({
            path: item.path,
            message: error instanceof Error ? error.message : '媒体文件恢复失败。',
        });

        if (isNoSuchKeyError(error)) {
            throw new R2ChunkedBackupObjectMissingError('R2 v2 media object is missing.', 'read-media-object', item.key);
        }

        throw error;
    }
}

function assertExpectedCount(actual: number, expected: number, label: string): void {
    if (actual !== expected) {
        throw new R2ChunkedBackupIntegrityError(
            `R2 v2 ${label} count mismatch.`,
            `read-${label}`
        );
    }
}

function assertMediaIndexMatchesManifest(
    mediaManifest: EditorMediaManifest,
    mediaItems: R2ChunkedMediaIndexItem[]
): void {
    const itemsByPath = new Map(mediaItems.map((item) => [item.path, item]));

    if (itemsByPath.size !== mediaItems.length) {
        throw new R2ChunkedBackupIntegrityError('R2 v2 media index contains duplicate paths.', 'read-media-index');
    }

    for (const asset of mediaManifest.assets) {
        const item = itemsByPath.get(asset.path);

        if (
            !item ||
            item.publicPath !== asset.publicPath ||
            item.sha256 !== asset.hash ||
            item.size !== asset.size ||
            item.mimeType !== asset.mimeType
        ) {
            throw new R2ChunkedBackupIntegrityError('R2 v2 media index does not match media manifest.', 'read-media-index', asset.path);
        }
    }
}

function assertArticleObjectMatchesIndex(
    articleObject: ReturnType<typeof parseR2ChunkedArticleObject>,
    item: R2ChunkedArticleIndexItem
): asserts articleObject is NonNullable<ReturnType<typeof parseR2ChunkedArticleObject>> {
    if (!articleObject || articleObject.id !== item.id || articleObject.data.id !== item.id) {
        throw new R2ChunkedBackupIntegrityError(
            'R2 v2 article object does not match article index.',
            'read-article-object',
            item.key
        );
    }
}

export async function materializeLatestChunkedBackupFromR2(): Promise<R2ChunkedRestorePackage> {
    const config = getR2BackupConfig();

    if (!config) {
        throw new R2BackupNotConfiguredError();
    }

    const client = createR2Client(config);
    const latest = await readLatestPointer(client, config);
    const snapshot = await readSnapshotManifest(client, config, latest.snapshotKey, latest.snapshotHash);
    const articleIndexes = await Promise.all(snapshot.articleIndexes.map((reference) =>
        getVerifiedJson(
            client,
            config,
            reference,
            'read-article-index',
            (value) => parseR2ChunkedArticleIndex(value, snapshot.snapshotId)
        )
    ));
    const mediaIndexes = await Promise.all(snapshot.mediaIndexes.map((reference) =>
        getVerifiedJson(
            client,
            config,
            reference,
            'read-media-index',
            (value) => parseR2ChunkedMediaIndex(value, snapshot.snapshotId)
        )
    ));
    const articleItems = articleIndexes.flatMap((index) => index.items);
    const mediaItems = mediaIndexes.flatMap((index) => index.items);
    const articleObjects = await Promise.all(articleItems.map(async (item) => {
        const articleObject = await getVerifiedJson(
            client,
            config,
            item,
            'read-article-object',
            parseR2ChunkedArticleObject
        );

        assertArticleObjectMatchesIndex(articleObject, item);

        return articleObject;
    }));
    const navigationObject = await getVerifiedJson(
        client,
        config,
        snapshot.navigation,
        'read-navigation',
        parseR2ChunkedNavigationObject
    );
    const settingsObject = await getVerifiedJson(
        client,
        config,
        snapshot.settings,
        'read-settings',
        parseR2ChunkedSettingsObject
    );
    const mediaManifestObject = await getVerifiedJson(
        client,
        config,
        snapshot.mediaManifest,
        'read-media-manifest',
        parseR2ChunkedMediaManifestObject
    );
    const articles = parseArticlesDataOrThrow(articleObjects.map((object) => object.data));
    const navigation = parseNavigationDataOrThrow(navigationObject.data);
    const settings = parseSiteSettingsOrThrow(settingsObject.data);
    const mediaManifest = parseEditorMediaManifest(mediaManifestObject.data);

    if (!mediaManifest) {
        throw new R2ChunkedBackupFormatError('R2 v2 media manifest format is invalid.', 'read-media-manifest', snapshot.mediaManifest.key);
    }

    assertExpectedCount(articles.length, snapshot.counts.articles, 'articles');
    assertExpectedCount(navigation.length, snapshot.counts.categories, 'navigation');
    assertExpectedCount(mediaManifest.assets.length, snapshot.counts.media, 'media');
    assertExpectedCount(articleItems.length, snapshot.counts.articles, 'article-index');
    assertExpectedCount(mediaItems.length, snapshot.counts.media, 'media-index');
    assertMediaIndexMatchesManifest(mediaManifest, mediaItems);

    const mediaRestore: EditorMediaRestoreResult = {
        total: mediaItems.length,
        restored: 0,
        skipped: 0,
        failed: 0,
        failures: [],
    };
    const mediaItemsByPath = new Map(mediaItems.map((item) => [item.path, item]));

    return {
        format: R2_CHUNKED_BACKUP_FORMAT,
        snapshotId: snapshot.snapshotId,
        data: {
            articles,
            navigation,
            settings,
            media: {
                manifest: mediaManifest,
                readFile: async (mediaPath: string) => {
                    const item = mediaItemsByPath.get(mediaPath);

                    if (!item) {
                        throw new Error(`R2 v2 media object is not indexed: ${mediaPath}`);
                    }

                    try {
                        const file = await readMediaObject(client, config, item, mediaRestore);
                        return file.bytes;
                    } catch {
                        throw new EditorMediaRestoreDownloadError(mediaRestore);
                    }
                },
            },
        },
        mediaRestore,
    };
}

export function createChunkedBackupFullKeyForTests(config: R2BackupConfig, relativeKey: string): string {
    return joinR2Key(config.prefix, relativeKey);
}
