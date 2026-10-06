import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '@/lib/article-data';
import { fsyncDirectory, writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { assertBackupStateWritableUnderLock, recordContentMutationUnderLock } from '@/lib/jobs/watermark';
import { createJsonRevision } from '@/lib/json-revision';
import { readVerifiedLiveSnapshot } from '@/lib/live-public-reader';

const MEDIA_MANIFEST_FILE_NAME = 'manifest.json';
export const MEDIA_FILES_DIRECTORY_NAME = 'files';
export const EDITOR_MEDIA_MANIFEST_VERSION = 1;
export const EDITOR_MEDIA_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type EditorMediaMimeType =
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/gif';

export interface EditorMediaAsset {
    id: string;
    path: string;
    publicPath: string;
    mimeType: EditorMediaMimeType;
    size: number;
    hash: string;
    createdAt: string;
    updatedAt: string;
}

export interface EditorMediaManifest {
    version: typeof EDITOR_MEDIA_MANIFEST_VERSION;
    updatedAt: string;
    assets: EditorMediaAsset[];
}

export interface StoredEditorMediaAsset {
    asset: EditorMediaAsset;
    filePath: string;
    created: boolean;
}

export interface EditorMediaConsistencyReport {
    checkedAssets: number;
    checkedFiles: number;
    missingFiles: string[];
    hashMismatches: string[];
    orphanFiles: string[];
}

export class EditorMediaInvalidFileError extends Error {
    constructor(message = 'Unsupported media file.') {
        super(message);
        this.name = 'EditorMediaInvalidFileError';
    }
}

export class EditorMediaFileTooLargeError extends Error {
    constructor(public readonly limitBytes = EDITOR_MEDIA_MAX_IMAGE_BYTES) {
        super(`Media file exceeds ${limitBytes} bytes.`);
        this.name = 'EditorMediaFileTooLargeError';
    }
}

export class EditorMediaPathInvalidError extends Error {
    constructor(public readonly mediaPath: string) {
        super(`Invalid media path: ${mediaPath}`);
        this.name = 'EditorMediaPathInvalidError';
    }
}

export class EditorMediaManifestInvalidError extends Error {
    constructor(public readonly filePath: string) {
        super('Stored editor media manifest is invalid.');
        this.name = 'EditorMediaManifestInvalidError';
    }
}

function getMediaRootPath(): string {
    return path.join(getRuntimeDataRootPath(), 'media');
}

export function getMediaManifestFilePath(): string {
    return path.join(getMediaRootPath(), MEDIA_MANIFEST_FILE_NAME);
}

function getMediaFilesRootPath(): string {
    return path.join(getMediaRootPath(), MEDIA_FILES_DIRECTORY_NAME);
}

function createEmptyMediaManifest(): EditorMediaManifest {
    return {
        version: EDITOR_MEDIA_MANIFEST_VERSION,
        updatedAt: new Date().toISOString(),
        assets: [],
    };
}

export function isSafeMediaRelativePath(value: string): boolean {
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

function isEditorMediaMimeType(value: unknown): value is EditorMediaMimeType {
    return (
        value === 'image/png' ||
        value === 'image/jpeg' ||
        value === 'image/webp' ||
        value === 'image/gif'
    );
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isMediaAsset(value: unknown): value is EditorMediaAsset {
    if (!isRecord(value)) {
        return false;
    }

    return (
        typeof value.id === 'string' &&
        typeof value.path === 'string' &&
        isSafeMediaRelativePath(value.path) &&
        typeof value.publicPath === 'string' &&
        value.publicPath === `/media/${value.path}` &&
        isEditorMediaMimeType(value.mimeType) &&
        isFiniteNonNegativeNumber(value.size) &&
        typeof value.hash === 'string' &&
        value.hash === value.id &&
        /^[a-f0-9]{64}$/i.test(value.hash) &&
        typeof value.createdAt === 'string' &&
        typeof value.updatedAt === 'string'
    );
}

export function parseEditorMediaManifest(value: unknown): EditorMediaManifest | null {
    if (!isRecord(value) || value.version !== EDITOR_MEDIA_MANIFEST_VERSION || !Array.isArray(value.assets)) {
        return null;
    }

    if (value.assets.some((asset) => !isMediaAsset(asset))) {
        return null;
    }

    return {
        version: EDITOR_MEDIA_MANIFEST_VERSION,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
        assets: value.assets,
    };
}

export function readEditorMediaManifest(): EditorMediaManifest {
    const filePath = getMediaManifestFilePath();

    if (!fs.existsSync(filePath)) {
        return createEmptyMediaManifest();
    }

    try {
        const manifest = parseEditorMediaManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')));

        if (!manifest) {
            throw new EditorMediaManifestInvalidError(filePath);
        }

        return manifest;
    } catch (error) {
        if (error instanceof EditorMediaManifestInvalidError) {
            throw error;
        }

        throw new EditorMediaManifestInvalidError(filePath);
    }
}

export async function writeEditorMediaManifest(manifest: EditorMediaManifest): Promise<void> {
    await withRuntimeDataRootLock(() => {
        // Media is content too: a damaged watermark or job file must stop this write
        // exactly like the article/navigation/settings writers, so an upload can never
        // land without its dirty watermark entry.
        assertBackupStateWritableUnderLock(getRuntimeDataRootPath());
        writeJsonAtomically(getMediaManifestFilePath(), manifest);
        recordContentMutationUnderLock(getRuntimeDataRootPath(), {
            resource: 'media',
            revision: manifest.updatedAt,
            digest: createJsonRevision(manifest),
            value: manifest,
        });
    });
}

function getMimeTypeFromBytes(bytes: Uint8Array): { mimeType: EditorMediaMimeType; extension: string } | null {
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return { mimeType: 'image/png', extension: 'png' };
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mimeType: 'image/jpeg', extension: 'jpg' };
    }

    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return { mimeType: 'image/webp', extension: 'webp' };
    }

    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    ) {
        return { mimeType: 'image/gif', extension: 'gif' };
    }

    return null;
}

function createMediaPath(hash: string, extension: string, now = new Date()): string {
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    return `${MEDIA_FILES_DIRECTORY_NAME}/${year}/${month}/${hash}.${extension}`;
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function resolveMediaFilePath(mediaPath: string): string {
    if (!isSafeMediaRelativePath(mediaPath)) {
        throw new EditorMediaPathInvalidError(mediaPath);
    }

    const filesRoot = path.resolve(getMediaFilesRootPath());
    const filePath = path.resolve(getMediaRootPath(), mediaPath);

    if (filePath !== filesRoot && !filePath.startsWith(filesRoot + path.sep)) {
        throw new EditorMediaPathInvalidError(mediaPath);
    }

    return filePath;
}

export function resolvePublicMediaFilePath(mediaPath: string): string {
    return resolveMediaFilePath(mediaPath);
}

function mergeMediaAsset(manifest: EditorMediaManifest, asset: EditorMediaAsset): EditorMediaManifest {
    const previous = manifest.assets.find((item) => item.id === asset.id);
    const nextAsset = previous
        ? {
            ...previous,
            updatedAt: asset.updatedAt,
        }
        : asset;
    const nextAssets = previous
        ? manifest.assets.map((item) => item.id === asset.id ? nextAsset : item)
        : [...manifest.assets, nextAsset];

    return {
        version: EDITOR_MEDIA_MANIFEST_VERSION,
        updatedAt: asset.updatedAt,
        assets: nextAssets.sort((a, b) => a.path.localeCompare(b.path)),
    };
}

async function writeMediaFileDurably(filePath: string, bytes: Uint8Array): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const fileHandle = await fsPromises.open(tempPath, 'wx');

    try {
        await fileHandle.writeFile(bytes);
        await fileHandle.sync();
        await fileHandle.close();
        fs.renameSync(tempPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    } catch (error) {
        await fileHandle.close().catch(() => undefined);
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
}

async function isMediaFileCurrent(filePath: string, expectedHash: string, expectedSize: number): Promise<boolean> {
    try {
        const bytes = await fsPromises.readFile(filePath);

        return bytes.byteLength === expectedSize && sha256Hex(bytes) === expectedHash;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }

        throw error;
    }
}

async function ensureMediaFileDurably(filePath: string, bytes: Uint8Array, hash: string): Promise<boolean> {
    const exists = fs.existsSync(filePath);

    if (exists && await isMediaFileCurrent(filePath, hash, bytes.byteLength)) {
        return false;
    }

    await writeMediaFileDurably(filePath, bytes);

    return !exists;
}

export async function storeEditorMediaFile(input: {
    bytes: Uint8Array;
    now?: Date;
}): Promise<StoredEditorMediaAsset> {
    const bytes = input.bytes;

    if (bytes.byteLength > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
        throw new EditorMediaFileTooLargeError();
    }

    const detected = getMimeTypeFromBytes(bytes);

    if (!detected) {
        throw new EditorMediaInvalidFileError('仅支持 PNG、JPEG、WebP 和 GIF 图片。');
    }

    const hash = sha256Hex(bytes);
    const now = input.now ?? new Date();
    const updatedAt = now.toISOString();
    const manifest = readEditorMediaManifest();
    const existing = manifest.assets.find((asset) => asset.id === hash);
    const mediaPath = existing?.path ?? createMediaPath(hash, detected.extension, now);
    const filePath = resolveMediaFilePath(mediaPath);
    const asset: EditorMediaAsset = existing ?? {
        id: hash,
        path: mediaPath,
        publicPath: `/media/${mediaPath}`,
        mimeType: detected.mimeType,
        size: bytes.byteLength,
        hash,
        createdAt: updatedAt,
        updatedAt,
    };
    const created = await ensureMediaFileDurably(filePath, bytes, hash);

    try {
        await writeEditorMediaManifest(mergeMediaAsset(manifest, {
            ...asset,
            updatedAt,
        }));
    } catch (error) {
        if (created) {
            fs.rmSync(filePath, { force: true });
            fsyncDirectory(path.dirname(filePath));
        }

        throw error;
    }

    return {
        asset: {
            ...asset,
            updatedAt,
        },
        filePath,
        created,
    };
}

export async function writeRestoredEditorMediaManifest(manifest: EditorMediaManifest): Promise<void> {
    await writeEditorMediaManifest({
        version: EDITOR_MEDIA_MANIFEST_VERSION,
        updatedAt: new Date().toISOString(),
        assets: manifest.assets,
    });
}

export async function readEditorMediaFile(asset: EditorMediaAsset): Promise<Uint8Array | null> {
    const filePath = resolveMediaFilePath(asset.path);

    try {
        return await fsPromises.readFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

export async function writeRestoredEditorMediaFile(asset: EditorMediaAsset, bytes: Uint8Array): Promise<void> {
    const hash = sha256Hex(bytes);

    if (hash !== asset.hash) {
        throw new EditorMediaInvalidFileError(`媒体文件校验失败：${asset.path}`);
    }

    const filePath = resolveMediaFilePath(asset.path);
    await writeMediaFileDurably(filePath, bytes);
}

export async function isEditorMediaAssetPresent(asset: EditorMediaAsset): Promise<boolean> {
    const bytes = await readEditorMediaFile(asset);

    if (!bytes) {
        return false;
    }

    return sha256Hex(bytes) === asset.hash;
}

function toMediaRelativePath(filePath: string): string {
    return path.relative(getMediaRootPath(), filePath).replace(/\\/g, '/');
}

function collectStoredMediaFilePaths(directoryPath: string): string[] {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            return collectStoredMediaFilePaths(entryPath);
        }

        if (!entry.isFile()) {
            return [];
        }

        return [toMediaRelativePath(entryPath)];
    });
}

export async function verifyEditorMediaStorageConsistency(): Promise<EditorMediaConsistencyReport> {
    const manifest = readEditorMediaManifest();
    const knownPaths = new Set(manifest.assets.map((asset) => asset.path));
    const storedFiles = collectStoredMediaFilePaths(getMediaFilesRootPath());
    const storedPathSet = new Set(storedFiles);
    const report: EditorMediaConsistencyReport = {
        checkedAssets: manifest.assets.length,
        checkedFiles: storedFiles.length,
        missingFiles: [],
        hashMismatches: [],
        orphanFiles: storedFiles.filter((filePath) => !knownPaths.has(filePath)).sort(),
    };

    for (const asset of manifest.assets) {
        if (!storedPathSet.has(asset.path)) {
            report.missingFiles.push(asset.path);
            continue;
        }

        if (!await isEditorMediaAssetPresent(asset)) {
            report.hashMismatches.push(asset.path);
        }
    }

    report.missingFiles.sort();
    report.hashMismatches.sort();

    return report;
}

const MEDIA_HASH_FILE_PATTERN = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

function isManagedMediaFileName(fileName: string): boolean {
    return MEDIA_HASH_FILE_PATTERN.test(fileName);
}

export async function collectOrphanMediaFiles(): Promise<string[]> {
    const manifest = readEditorMediaManifest();
    const knownPaths = new Set(manifest.assets.map((asset) => asset.path));
    // A sealed live release can reference media that the current working manifest no longer
    // lists (restore, manual manifest edit). Those bytes still back the published site, so
    // they must survive GC. An invalid live pointer fails closed instead of deleting them.
    for (const media of readVerifiedLiveSnapshot()?.snapshot.media ?? []) {
        knownPaths.add(media.originalPath);
    }

    return collectStoredMediaFilePaths(getMediaFilesRootPath())
        .filter((filePath) => !knownPaths.has(filePath))
        .sort();
}

export async function deleteOrphanMediaFiles(): Promise<{ deleted: number; freedBytes: number }> {
    const orphanPaths = await collectOrphanMediaFiles();
    let deleted = 0;
    let freedBytes = 0;

    for (const relativePath of orphanPaths) {
        if (!isSafeMediaRelativePath(relativePath)) {
            continue;
        }

        const fileName = relativePath.split('/').pop() ?? '';

        if (!isManagedMediaFileName(fileName)) {
            continue;
        }

        const absolutePath = path.join(getMediaRootPath(), relativePath);
        const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });

        if (!stats?.isFile()) {
            continue;
        }

        fs.rmSync(absolutePath, { force: true });
        freedBytes += stats.size;
        deleted += 1;
    }

    return { deleted, freedBytes };
}
