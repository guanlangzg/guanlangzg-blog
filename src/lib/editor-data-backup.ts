import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isRecord, parseArticlesDataOrThrow } from '@/lib/article-data';
import {
    createDerivedEditorDataManifestSnapshot,
    createEditorDataManifestSnapshot,
    EDITOR_DATA_SCHEMA_VERSION,
    EditorDataRootUnavailableError,
    getEditorDataRoot,
    readArticlesFromDisk,
    readNavigationFromDisk,
    readSiteSettingsFromDisk,
    restoreEditorDataRootAtomically,
    withEditorDataRootLock,
    type EditorDataManifest,
    type EditorDataResourceName,
} from '@/lib/editor-data-storage';
import { parseNavigationDataOrThrow } from '@/lib/navigation-data';
import {
    createDefaultSiteSettings,
    parseSiteSettingsOrThrow,
    type SiteSettings,
} from '@/lib/site-settings';
import {
    parseEditorMediaManifest,
    getMediaManifestFilePath,
    readEditorMediaFile,
    readEditorMediaManifest,
    writeRestoredEditorMediaManifest,
    type EditorMediaAsset,
    type EditorMediaManifest,
} from '@/lib/editor-media-storage';
import { isEncryptedBackupPayload } from '@/lib/backup-encryption';
import { isRuntimeDataRootWritableSync } from '@/lib/runtime-data-root';

export const EDITOR_BACKUP_VERSION = 1;

export type EditorBackupSource = 'local' | 'r2';

export interface EditorBackupMediaInlineFile {
    path: string;
    bytes: Uint8Array;
}

export interface EditorBackupMediaData {
    manifest: EditorMediaManifest;
    files?: EditorBackupMediaInlineFile[];
    readFile?: (path: string) => Promise<Uint8Array>;
}

export interface EditorBackupData {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
    media?: EditorBackupMediaData;
}

type EditorBackupPayloadMediaFile = {
    path: string;
    data: string;
};

type EditorBackupPayloadMedia = {
    manifest: EditorMediaManifest;
    files?: EditorBackupPayloadMediaFile[];
};

export interface EditorBackupPayloadData {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
    media?: EditorMediaManifest | EditorBackupPayloadMedia;
}

export interface EditorBackupPayload {
    version: typeof EDITOR_BACKUP_VERSION;
    schemaVersion?: typeof EDITOR_DATA_SCHEMA_VERSION;
    exportedAt: string;
    source: EditorBackupSource;
    persistent: boolean;
    dataRoot: string | null;
    manifest?: EditorDataManifest;
    data: EditorBackupPayloadData;
}

export interface EditorRemoteBackupMediaAsset {
    asset: EditorMediaAsset;
    bytes: Uint8Array;
}

export interface CurrentEditorRemoteBackupPackage {
    payload: EditorBackupPayload;
    mediaAssets: EditorRemoteBackupMediaAsset[];
}

export interface RestoreBackupResult {
    articles: number;
    categories: number;
    settings: boolean;
    media: number;
}

interface RestoreBackupOptions {
    currentManifest?: EditorBackupRestorePrecondition;
    requireInlineMediaFiles?: boolean;
}

export type EditorDataManifestSnapshotReference = {
    manifest: EditorDataManifest;
    manifestHash: string;
};

export interface EditorBackupRestorePrecondition {
    manifest: EditorDataManifest;
    mediaHash?: string | null;
}

export class EditorBackupFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EditorBackupFormatError';
    }
}

export class EditorBackupVersionError extends Error {
    constructor(
        message: string,
        public readonly version: number | null = null
    ) {
        super(message);
        this.name = 'EditorBackupVersionError';
    }
}

export class EditorBackupSchemaVersionError extends Error {
    constructor(
        message: string,
        public readonly schemaVersion: number | null = null
    ) {
        super(message);
        this.name = 'EditorBackupSchemaVersionError';
    }
}

export class EditorBackupRestoreConflictError extends Error {
    constructor(public readonly currentManifest: EditorBackupRestorePrecondition) {
        super('Current editor data manifest does not match the restore precondition.');
        this.name = 'EditorBackupRestoreConflictError';
    }
}

function createCurrentEditorManifestSnapshot(): EditorDataManifest {
    return createEditorDataManifestSnapshot({
        articles: readArticlesFromDisk(),
        navigation: readNavigationFromDisk(),
        settings: readSiteSettingsFromDisk(),
    });
}

function createCurrentEditorMediaStateHash(): string | null {
    const filePath = getMediaManifestFilePath();

    if (!fs.existsSync(filePath)) {
        return null;
    }

    return createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}

function readCurrentEditorBackupData(): EditorBackupData {
    return {
        articles: readArticlesFromDisk(),
        navigation: readNavigationFromDisk(),
        settings: readSiteSettingsFromDisk(),
    };
}

function createBase64Bytes(value: Uint8Array): string {
    return Buffer.from(value).toString('base64');
}

function parseBase64Bytes(value: string): Uint8Array | null {
    if (
        value.length === 0 ||
        value.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) {
        return null;
    }

    return new Uint8Array(Buffer.from(value, 'base64'));
}

function hashBytes(value: Uint8Array): string {
    return createHash('sha256')
        .update(value)
        .digest('hex');
}

async function readCurrentEditorBackupMedia(includeFiles: boolean): Promise<EditorBackupMediaData> {
    const manifest = readEditorMediaManifest();

    if (!includeFiles) {
        return { manifest };
    }

    const files = await Promise.all(manifest.assets.map(async (asset) => {
        const bytes = await readEditorMediaFile(asset);

        if (!bytes) {
            throw new Error(`Missing media file: ${asset.path}`);
        }

        return {
            path: asset.path,
            bytes,
        };
    }));

    return {
        manifest,
        files,
    };
}

async function readCurrentEditorBackupDataWithMedia(options: {
    includeInlineMediaFiles?: boolean;
} = {}): Promise<EditorBackupData> {
    return {
        ...readCurrentEditorBackupData(),
        media: await readCurrentEditorBackupMedia(Boolean(options.includeInlineMediaFiles)),
    };
}

function isSameResourceManifest(
    expected: EditorDataManifest['resources'][EditorDataResourceName],
    current: EditorDataManifest['resources'][EditorDataResourceName]
): boolean {
    return Boolean(
        expected &&
        current &&
        expected.revision === current.revision &&
        expected.hash === current.hash
    );
}

function isSameManifestSnapshot(expected: EditorDataManifest, current: EditorDataManifest): boolean {
    if (expected.version !== current.version) {
        return false;
    }

    for (const resource of ['articles', 'navigation', 'settings'] as const) {
        if (!isSameResourceManifest(expected.resources[resource], current.resources[resource])) {
            return false;
        }
    }

    return true;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => {
            const record = value as Record<string, unknown>;

            return `${JSON.stringify(key)}:${stableStringify(record[key])}`;
        }).join(',')}}`;
    }

    return JSON.stringify(value);
}

export function createEditorDataManifestHash(manifest: EditorDataManifest): string {
    const resourceHashes = {
        articles: manifest.resources.articles?.hash ?? null,
        navigation: manifest.resources.navigation?.hash ?? null,
        settings: manifest.resources.settings?.hash ?? null,
    };

    return createHash('sha256')
        .update(stableStringify({
            version: manifest.version,
            resources: resourceHashes,
        }))
        .digest('hex');
}

export function createCurrentEditorManifestSnapshotReference(data?: EditorBackupData): EditorDataManifestSnapshotReference {
    const manifest = data
        ? createEditorDataManifestSnapshot(data)
        : createCurrentEditorManifestSnapshot();

    return {
        manifest,
        manifestHash: createEditorDataManifestHash(manifest),
    };
}

export function isSameEditorManifestSnapshot(expected: EditorDataManifest, current: EditorDataManifest): boolean {
    return isSameManifestSnapshot(expected, current);
}

function createCurrentEditorBackupRestorePrecondition(): EditorBackupRestorePrecondition {
    return {
        manifest: createCurrentEditorManifestSnapshot(),
        mediaHash: createCurrentEditorMediaStateHash(),
    };
}

function assertCurrentManifestForRestore(
    expected: EditorBackupRestorePrecondition,
    options: { includeMedia?: boolean } = {}
): void {
    const currentState = createCurrentEditorBackupRestorePrecondition();

    if (!isSameManifestSnapshot(expected.manifest, currentState.manifest)) {
        throw new EditorBackupRestoreConflictError(currentState);
    }

    if (options.includeMedia && expected.mediaHash !== undefined && expected.mediaHash !== currentState.mediaHash) {
        throw new EditorBackupRestoreConflictError(currentState);
    }
}

export function assertEditorBackupRestoreCurrentManifest(
    expected: EditorBackupRestorePrecondition,
    options: { includeMedia?: boolean } = {}
): void {
    return assertCurrentManifestForRestore(expected, options);
}

export function createCurrentEditorBackupRestorePreconditionReference(): EditorBackupRestorePrecondition {
    return createCurrentEditorBackupRestorePrecondition();
}

function createBackupPayloadManifest(data: EditorBackupData): EditorDataManifest {
    try {
        return createEditorDataManifestSnapshot(data);
    } catch (error) {
        if (!(error instanceof EditorDataRootUnavailableError)) {
            throw error;
        }

        return createDerivedEditorDataManifestSnapshot(data);
    }
}

function serializeEditorBackupMedia(
    media: EditorBackupMediaData | undefined
): EditorBackupPayloadData['media'] | undefined {
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

export function createEditorBackupPayload(
    data: EditorBackupData,
    source: EditorBackupSource = 'local'
): EditorBackupPayload {
    const dataRoot = getEditorDataRoot();

    return {
        version: EDITOR_BACKUP_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        source,
        persistent: Boolean(dataRoot && isRuntimeDataRootWritableSync(dataRoot)),
        dataRoot,
        manifest: createBackupPayloadManifest(data),
        data: {
            articles: data.articles,
            navigation: data.navigation,
            settings: data.settings,
            ...(data.media ? { media: serializeEditorBackupMedia(data.media) } : {}),
        },
    };
}

export async function createCurrentEditorBackupPayload(options: {
    includeInlineMediaFiles?: boolean;
} = {}): Promise<EditorBackupPayload> {
    return withEditorDataRootLock(async () => {
        return createEditorBackupPayload(
            await readCurrentEditorBackupDataWithMedia(options)
        );
    });
}

export async function createCurrentEditorRemoteBackupPackage(): Promise<CurrentEditorRemoteBackupPackage> {
    return withEditorDataRootLock(async () => {
        const data = await readCurrentEditorBackupDataWithMedia({
            includeInlineMediaFiles: true,
        });
        const assetsByPath = new Map(data.media?.manifest.assets.map((asset) => [asset.path, asset]) ?? []);
        const mediaAssets = (data.media?.files ?? []).map((file) => {
            const asset = assetsByPath.get(file.path);

            if (!asset) {
                throw new Error(`Missing media asset metadata for backup: ${file.path}`);
            }

            return {
                asset,
                bytes: file.bytes,
            };
        });
        const payloadData: EditorBackupData = data.media
            ? {
                ...data,
                media: {
                    manifest: data.media.manifest,
                },
            }
            : data;

        return {
            payload: createEditorBackupPayload(payloadData, 'r2'),
            mediaAssets,
        };
    });
}

function readEditorBackupMedia(
    value: unknown
): EditorBackupMediaData | undefined {
    if (value === undefined) {
        return undefined;
    }

    const legacyManifest = parseEditorMediaManifest(value);

    if (legacyManifest) {
        return {
            manifest: legacyManifest,
        };
    }

    if (!isRecord(value)) {
        throw new EditorBackupFormatError('备份媒体数据格式无效。');
    }

    const manifest = parseEditorMediaManifest(value.manifest);

    if (!manifest) {
        throw new EditorBackupFormatError('备份媒体清单格式无效。');
    }

    if (value.files === undefined) {
        return {
            manifest,
        };
    }

    if (!Array.isArray(value.files)) {
        throw new EditorBackupFormatError('备份媒体文件列表必须是数组。');
    }

    const assetsByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
    const parsedFiles: EditorBackupMediaInlineFile[] = [];
    const seenPaths = new Set<string>();

    for (const file of value.files) {
        if (!isRecord(file) || typeof file.path !== 'string' || typeof file.data !== 'string') {
            throw new EditorBackupFormatError('备份媒体文件格式无效。');
        }

        const asset = assetsByPath.get(file.path);

        if (!asset || seenPaths.has(file.path)) {
            throw new EditorBackupFormatError(`备份媒体文件与清单不匹配：${file.path}`);
        }

        const bytes = parseBase64Bytes(file.data);

        if (!bytes || bytes.byteLength !== asset.size || hashBytes(bytes) !== asset.hash) {
            throw new EditorBackupFormatError(`备份媒体文件校验失败：${file.path}`);
        }

        seenPaths.add(file.path);
        parsedFiles.push({
            path: file.path,
            bytes,
        });
    }

    return {
        manifest,
        files: parsedFiles,
    };
}

function hasRequiredInlineMediaFiles(media: EditorBackupMediaData | undefined): boolean {
    if (!media) {
        return true;
    }

    const assetPaths = media.manifest.assets.map((asset) => asset.path);

    if (assetPaths.length === 0) {
        return true;
    }

    if (media.readFile) {
        return true;
    }

    if (!media.files || media.files.length !== assetPaths.length) {
        return false;
    }

    const filePaths = new Set(media.files.map((file) => file.path));

    return filePaths.size === assetPaths.length && assetPaths.every((assetPath) => filePaths.has(assetPath));
}

function readEditorBackupVersion(value: unknown): number {
    if (!isRecord(value) || value.version === undefined) {
        return EDITOR_BACKUP_VERSION;
    }

    const version = value.version;

    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new EditorBackupVersionError('备份 version 必须是大于 0 的整数。');
    }

    if (version > EDITOR_BACKUP_VERSION) {
        throw new EditorBackupVersionError(
            `备份 version ${version} 高于当前支持的 ${EDITOR_BACKUP_VERSION}，请先升级服务后再恢复。`,
            version
        );
    }

    return version;
}

function readEditorBackupSchemaVersion(value: unknown): number {
    if (!isRecord(value) || value.schemaVersion === undefined) {
        return EDITOR_DATA_SCHEMA_VERSION;
    }

    const schemaVersion = value.schemaVersion;

    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new EditorBackupSchemaVersionError('备份 schemaVersion 必须是大于 0 的整数。');
    }

    if (schemaVersion > EDITOR_DATA_SCHEMA_VERSION) {
        throw new EditorBackupSchemaVersionError(
            `备份 schemaVersion ${schemaVersion} 高于当前支持的 ${EDITOR_DATA_SCHEMA_VERSION}，请先升级服务后再恢复。`,
            schemaVersion
        );
    }

    return schemaVersion;
}

function wrapEditorBackupParseError<T>(parse: () => T, fallbackMessage: string): T {
    try {
        return parse();
    } catch (error) {
        throw new EditorBackupFormatError(
            error instanceof Error ? error.message : fallbackMessage
        );
    }
}

export function parseEditorBackupDataOrThrow(value: unknown): EditorBackupData {
    if (!isRecord(value)) {
        throw new EditorBackupFormatError('备份文件必须是 JSON 对象。');
    }

    if (isEncryptedBackupPayload(value)) {
        throw new EditorBackupFormatError('检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。');
    }

    readEditorBackupVersion(value);
    readEditorBackupSchemaVersion(value);

    const source = isRecord(value.data) ? value.data : value;

    if (!Array.isArray(source.articles) || !Array.isArray(source.navigation)) {
        throw new EditorBackupFormatError('备份文件必须包含 articles 和 navigation 数组。');
    }

    const articles = wrapEditorBackupParseError(
        () => parseArticlesDataOrThrow(source.articles),
        '备份文章数据格式无效。'
    );
    const navigation = wrapEditorBackupParseError(
        () => parseNavigationDataOrThrow(source.navigation),
        '备份导航数据格式无效。'
    );
    const settings =
        source.settings === undefined
            ? createDefaultSiteSettings()
            : wrapEditorBackupParseError(
                () => parseSiteSettingsOrThrow(source.settings),
                '备份站点设置格式无效。'
            );
    const media = readEditorBackupMedia(source.media);

    return {
        articles,
        navigation,
        settings,
        ...(media ? { media } : {}),
    };
}

export function parseEditorBackupData(value: unknown): EditorBackupData | null {
    try {
        return parseEditorBackupDataOrThrow(value);
    } catch (error) {
        if (error instanceof EditorBackupFormatError) {
            return null;
        }

        throw error;
    }
}

async function restoreParsedEditorBackupData(
    data: EditorBackupData,
    options: RestoreBackupOptions = {}
): Promise<RestoreBackupResult> {
    if (options.requireInlineMediaFiles && !hasRequiredInlineMediaFiles(data.media)) {
        throw new EditorBackupFormatError('备份媒体文件缺失或不完整。');
    }

    return withEditorDataRootLock(async () => {
        if (options.currentManifest) {
            assertCurrentManifestForRestore(options.currentManifest, {
                includeMedia: Boolean(data.media),
            });
        }

        await restoreEditorDataRootAtomically(data);

        if (data.media && !data.media.files && !data.media.readFile) {
            await writeRestoredEditorMediaManifest(data.media.manifest);
        }

        return {
            articles: data.articles.length,
            categories: data.navigation.length,
            settings: true,
            media: data.media?.manifest.assets.length ?? 0,
        };
    });
}

export async function restoreEditorBackupData(
    data: EditorBackupData,
    options: RestoreBackupOptions = {}
): Promise<RestoreBackupResult> {
    return restoreParsedEditorBackupData(data, options);
}

export async function restoreEditorBackupPayload(
    value: unknown,
    options: RestoreBackupOptions = {}
): Promise<RestoreBackupResult> {
    const data = parseEditorBackupDataOrThrow(value);
    return restoreParsedEditorBackupData(data, options);
}
