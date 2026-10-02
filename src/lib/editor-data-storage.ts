import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { assertUniqueArticleSlugs, parseArticlesData } from '@/lib/article-data';
import { parseNavigationData } from '@/lib/navigation-data';
import {
    createDefaultSiteSettings,
    parseSiteSettings,
    type SiteSettings,
} from '@/lib/site-settings';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { resetEditorRuntimeCaches } from '@/lib/editor-runtime-cache';
import { recordEditorAuditEvent } from '@/lib/editor-audit-log';
import { writeSearchIndexForData } from '@/lib/search-index';
import { createArticleIndex } from '@/lib/article-index';
import {
    applyArticlePatchOperations,
    type ArticlePatchOperation,
} from '@/lib/article-resource-patch';
import { writeJsonAtomically as writeJsonAtomicallyShared } from '@/lib/atomic-json-writer';
import {
    isRuntimeDataRootAvailable,
    isRuntimeDataRootAvailableSync,
} from '@/lib/runtime-data-root';
import {
    commitResourceManifestTransaction,
    hasIncompleteManifestTransaction,
    recoverIncompleteManifestTransaction,
    ManifestTransactionIncompleteError,
} from '@/lib/manifest-transaction';
import {
    EditorDataLockTimeoutError,
    EditorDataRootUnavailableError,
    acquireEditorDataRootLock,
    getHeldEditorDataLockCount,
    releaseEditorDataRootLock,
    runWithHeldEditorDataLockContext,
} from '@/lib/editor-data-lock';
import {
    isSafeMediaRelativePath,
    MEDIA_FILES_DIRECTORY_NAME,
} from '@/lib/editor-media-storage';
import type { EditorMediaManifest } from '@/lib/editor-media-storage';
import { createJsonRevision } from '@/lib/json-revision';
import {
    recordContentMutationUnderLock,
    recordRestoredContentMutationUnderLock,
} from '@/lib/jobs/watermark';

const ARTICLES_FILE_NAME = 'articles.json';
const NAVIGATION_FILE_NAME = 'tools.json';
const SETTINGS_FILE_NAME = 'site.json';
const MANIFEST_FILE_NAME = 'manifest.json';
const MEDIA_DIRECTORY_NAME = 'media';
const MEDIA_MANIFEST_FILE_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
export const EDITOR_DATA_SCHEMA_VERSION = 1;
const DATA_CACHE_TTL_MS = 2_000;
const RESTORE_STATE_FILE_NAME = '.restore-state.json';
const RESTORE_STATE_VERSION = 1;

export type EditorDataResourceName = 'articles' | 'navigation' | 'settings';
export type EditorDataFileResourceName = EditorDataResourceName | 'manifest' | 'navigation-seed';

export interface EditorDataResourceManifest {
    revision: string;
    hash: string;
    updatedAt: string;
}

export interface EditorDataManifest {
    version: typeof MANIFEST_VERSION;
    schemaVersion?: typeof EDITOR_DATA_SCHEMA_VERSION;
    updatedAt: string;
    resources: Partial<Record<EditorDataResourceName, EditorDataResourceManifest>>;
}

export type EditorDataResourceWriteResult<T> =
    | {
        success: true;
        resourceManifest: EditorDataResourceManifest;
    }
    | {
        success: false;
        currentValue: T;
        currentManifest: EditorDataResourceManifest | null;
    };

export class EditorDataRootNotConfiguredError extends Error {
    constructor() {
        super('Runtime data root is not configured.');
        this.name = 'EditorDataRootNotConfiguredError';
    }
}

export { EditorDataLockTimeoutError, EditorDataRootUnavailableError };
export { ManifestTransactionIncompleteError };

export class EditorDataFileInvalidError extends Error {
    constructor(
        public readonly resource: EditorDataFileResourceName,
        public readonly filePath: string,
        public readonly reason: string
    ) {
        super(`Invalid editor data file for ${resource}: ${reason}`);
        this.name = 'EditorDataFileInvalidError';
    }
}

export class EditorDataRestoreIncompleteError extends Error {
    constructor(public readonly statePath: string) {
        super('Editor data restore is incomplete and must be recovered before reads can continue.');
        this.name = 'EditorDataRestoreIncompleteError';
    }
}

const editorDataCache = new Map<string, {
    expiresAt: number;
    mtimeMs: number;
    size: number;
    value: unknown;
}>();

type EditorDataRestoreState = {
    version: typeof RESTORE_STATE_VERSION;
    phase: 'replacing' | 'committed';
    stagingDirectory: string;
    backupDirectory: string;
    files: string[];
    directories?: string[];
    updatedAt: string;
};

type EditorRestoreMediaData = {
    manifest: EditorMediaManifest;
    files?: Array<{
        path: string;
        bytes: Uint8Array;
    }>;
    readFile?: (path: string) => Promise<Uint8Array>;
};

function getEditorDataRootOrThrow(): string {
    const root = getEditorDataRoot();

    if (!root) {
        throw new EditorDataRootNotConfiguredError();
    }

    return root;
}

export async function withEditorDataRootLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const root = getEditorDataRootOrThrow();
    const resolvedRoot = path.resolve(root);
    const heldCount = getHeldEditorDataLockCount(resolvedRoot);

    if (heldCount > 0) {
        return await runWithHeldEditorDataLockContext(resolvedRoot, operation);
    }

    const lock = await acquireEditorDataRootLock(resolvedRoot);

    return await runWithHeldEditorDataLockContext(resolvedRoot, async () => {
        try {
            recoverEditorDataRootState(resolvedRoot);
            return await operation();
        } finally {
            releaseEditorDataRootLock(lock);
        }
    });
}

function getCachedJsonFile(filePath: string | null, stats: fs.Stats): unknown | undefined {
    if (!filePath) {
        return undefined;
    }

    const cached = editorDataCache.get(filePath);

    if (!cached) {
        return undefined;
    }

    if (
        cached.expiresAt <= Date.now() ||
        cached.mtimeMs !== stats.mtimeMs ||
        cached.size !== stats.size
    ) {
        editorDataCache.delete(filePath);
        return undefined;
    }

    return cached.value;
}

function setCachedJsonFile(filePath: string | null, value: unknown): void {
    if (!filePath) {
        return;
    }

    const stats = fs.statSync(filePath);
    setCachedJsonFileWithStats(filePath, value, stats);
}

function setCachedJsonFileWithStats(filePath: string | null, value: unknown, stats: fs.Stats): void {
    if (!filePath) {
        return;
    }

    editorDataCache.set(filePath, {
        expiresAt: Date.now() + DATA_CACHE_TTL_MS,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        value,
    });
}

function invalidateJsonFileCache(filePath: string | null): void {
    if (filePath) {
        editorDataCache.delete(filePath);
    }
}

function clearEditorDataCache(): void {
    editorDataCache.clear();
    resetEditorRuntimeCaches();
}

function getRestoreStateFilePath(root: string): string {
    return path.join(root, RESTORE_STATE_FILE_NAME);
}

function getEditorDataRootForReadRecovery(filePath: string | null): string | null {
    if (!filePath) {
        return null;
    }

    const root = getEditorDataRoot();

    if (!root) {
        return null;
    }

    const resolvedRoot = path.resolve(root);
    const resolvedFilePath = path.resolve(filePath);

    if (
        resolvedFilePath !== resolvedRoot &&
        !resolvedFilePath.startsWith(resolvedRoot + path.sep)
    ) {
        return null;
    }

    return resolvedRoot;
}

async function recoverIncompleteRestoreForRead(root: string): Promise<void> {
    const heldCount = getHeldEditorDataLockCount(root);

    if (heldCount > 0) {
        recoverIncompleteRestore(root);
        return;
    }

    const lock = await acquireEditorDataRootLock(root);

    await runWithHeldEditorDataLockContext(root, async () => {
        try {
            recoverIncompleteRestore(root);
        } finally {
            releaseEditorDataRootLock(lock);
        }
    });
}

function recoverIncompleteRestoreForReadSync(filePath: string | null): void {
    const root = getEditorDataRootForReadRecovery(filePath);

    if (!root) {
        return;
    }

    const restoreStatePath = getRestoreStateFilePath(root);

    if (fs.existsSync(restoreStatePath)) {
        const heldCount = getHeldEditorDataLockCount(root);

        if (heldCount > 0) {
            try {
                recoverIncompleteRestore(root);
            } catch (error) {
                console.error('[editor-data-storage] Failed to recover incomplete restore before read:', error);
                throw new EditorDataRestoreIncompleteError(restoreStatePath);
            }
            return;
        }

        // Skip lock acquisition in sync path to avoid blocking the event loop.
        // Recovery will complete on the next async write operation or explicit recovery call.
        throw new EditorDataRestoreIncompleteError(restoreStatePath);
    }
}

async function recoverIncompleteRestoreForReadAsync(filePath: string | null): Promise<void> {
    const root = getEditorDataRootForReadRecovery(filePath);
    if (!root) {
        return;
    }

    try {
        const restoreStatePath = getRestoreStateFilePath(root);
        await fsPromises.access(restoreStatePath);

        try {
            await recoverIncompleteRestoreForRead(root);
        } catch (error) {
            console.error('[editor-data-storage] Failed to recover incomplete restore before read:', error);
            throw new EditorDataRestoreIncompleteError(restoreStatePath);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }

        throw error;
    }
}

function recoverIncompleteManifestTransactionForReadSync(filePath: string | null): void {
    const root = getEditorDataRootForReadRecovery(filePath);

    if (!root || !hasIncompleteManifestTransaction(root)) {
        return;
    }

    const statePath = path.join(root, '.manifest-transaction.json');
    const heldCount = getHeldEditorDataLockCount(root);

    if (heldCount > 0) {
        try {
            recoverIncompleteManifestTransaction(root);
        } catch (error) {
            console.error('[editor-data-storage] Failed to recover incomplete manifest transaction before read:', error);
            throw new ManifestTransactionIncompleteError(statePath);
        }
        return;
    }

    throw new ManifestTransactionIncompleteError(statePath);
}

async function recoverIncompleteManifestTransactionForReadAsync(filePath: string | null): Promise<void> {
    const root = getEditorDataRootForReadRecovery(filePath);

    if (!root || !hasIncompleteManifestTransaction(root)) {
        return;
    }

    const lock = await acquireEditorDataRootLock(root);

    await runWithHeldEditorDataLockContext(root, async () => {
        try {
            recoverIncompleteManifestTransaction(root);
        } finally {
            releaseEditorDataRootLock(lock);
        }
    });
}

function ensureEditorDataRootAvailableForReadSync(filePath: string | null): void {
    const root = getEditorDataRootForReadRecovery(filePath);

    if (!root || isRuntimeDataRootAvailableSync(root)) {
        return;
    }

    throw new EditorDataRootUnavailableError(root, null);
}

async function ensureEditorDataRootAvailableForReadAsync(filePath: string | null): Promise<void> {
    const root = getEditorDataRootForReadRecovery(filePath);

    if (!root || await isRuntimeDataRootAvailable(root)) {
        return;
    }

    throw new EditorDataRootUnavailableError(root, null);
}

function readJsonFile(filePath: string | null, resource: EditorDataFileResourceName): unknown | null {
    recoverIncompleteRestoreForReadSync(filePath);
    recoverIncompleteManifestTransactionForReadSync(filePath);

    if (!filePath || !fs.existsSync(filePath)) {
        ensureEditorDataRootAvailableForReadSync(filePath);
        return null;
    }

    const stats = fs.statSync(filePath);
    const cached = getCachedJsonFile(filePath, stats);

    if (cached !== undefined) {
        return cached;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        setCachedJsonFile(filePath, parsed);
        return parsed;
    } catch (error) {
        console.error(`[editor-data-storage] Failed to read JSON: ${filePath}`, error);
        throw new EditorDataFileInvalidError(resource, filePath, 'invalid JSON');
    }
}

async function readJsonFileAsync(filePath: string | null, resource: EditorDataFileResourceName): Promise<unknown | null> {
    await recoverIncompleteRestoreForReadAsync(filePath);
    await recoverIncompleteManifestTransactionForReadAsync(filePath);

    if (!filePath) {
        return null;
    }

    let stats: fs.Stats;

    try {
        stats = await fsPromises.stat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await ensureEditorDataRootAvailableForReadAsync(filePath);
            return null;
        }

        throw error;
    }

    const cached = getCachedJsonFile(filePath, stats);

    if (cached !== undefined) {
        return cached;
    }

    try {
        const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        setCachedJsonFileWithStats(filePath, parsed, stats);
        return parsed;
    } catch (error) {
        console.error(`[editor-data-storage] Failed to read JSON: ${filePath}`, error);
        throw new EditorDataFileInvalidError(resource, filePath, 'invalid JSON');
    }
}

function createInvalidDataFileError(
    resource: EditorDataFileResourceName,
    filePath: string,
    reason: string
): EditorDataFileInvalidError {
    return new EditorDataFileInvalidError(resource, filePath, reason);
}

function ensureParentDirectory(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fsyncFile(filePath: string): void {
    const fileDescriptor = fs.openSync(filePath, 'r+');

    try {
        fs.fsyncSync(fileDescriptor);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function fsyncDirectory(directoryPath: string): void {
    try {
        const fileDescriptor = fs.openSync(directoryPath, 'r');

        try {
            fs.fsyncSync(fileDescriptor);
        } finally {
            fs.closeSync(fileDescriptor);
        }
    } catch (error) {
        if (process.platform !== 'win32') {
            throw error;
        }
    }
}

function writeJsonFile(filePath: string | null, value: unknown): void {
    if (!filePath) {
        throw new EditorDataRootNotConfiguredError();
    }

    try {
        writeJsonAtomicallyShared(filePath, value);
        setCachedJsonFile(filePath, value);
        resetEditorRuntimeCaches();
    } catch (error) {
        invalidateJsonFileCache(filePath);
        throw error;
    }
}

function refreshSearchIndexAfterResourceWrite(
    resource: EditorDataResourceName,
    value: unknown
): void {
    if (resource !== 'articles' && resource !== 'navigation') {
        return;
    }

    try {
        writeSearchIndexForData({
            articles: resource === 'articles' ? value as Article[] : readArticlesFromDisk(),
            navigation: resource === 'navigation' ? value as Category[] : readNavigationFromDisk(),
        });
    } catch (error) {
        console.warn('[editor-data-storage] Failed to refresh derived search index:', error);
    }
}

function createRestoreDirectory(root: string, name: string): string {
    const directory = path.join(root, `${name}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function parseRestoreState(value: unknown): EditorDataRestoreState | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as Partial<EditorDataRestoreState>;

    if (
        candidate.version !== RESTORE_STATE_VERSION ||
        (candidate.phase !== 'replacing' && candidate.phase !== 'committed') ||
        typeof candidate.stagingDirectory !== 'string' ||
        typeof candidate.backupDirectory !== 'string' ||
        !Array.isArray(candidate.files) ||
        candidate.files.some((filePath) => typeof filePath !== 'string') ||
        (
            candidate.directories !== undefined &&
            (!Array.isArray(candidate.directories) || candidate.directories.some((directoryPath) => typeof directoryPath !== 'string'))
        ) ||
        typeof candidate.updatedAt !== 'string'
    ) {
        return null;
    }

    return {
        version: RESTORE_STATE_VERSION,
        phase: candidate.phase,
        stagingDirectory: candidate.stagingDirectory,
        backupDirectory: candidate.backupDirectory,
        files: candidate.files as string[],
        ...(candidate.directories ? { directories: candidate.directories as string[] } : {}),
        updatedAt: candidate.updatedAt,
    };
}

function readRestoreState(root: string): EditorDataRestoreState | null {
    const statePath = getRestoreStateFilePath(root);

    if (!fs.existsSync(statePath)) {
        return null;
    }

    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parseRestoreState(parsed);
}

function writeRestoreState(root: string, state: EditorDataRestoreState): void {
    const statePath = getRestoreStateFilePath(root);
    ensureParentDirectory(statePath);

    const tempFilePath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2), 'utf8');
        fsyncFile(tempFilePath);
        fs.renameSync(tempFilePath, statePath);
        fsyncDirectory(root);
    } catch (error) {
        fs.rmSync(tempFilePath, { force: true });
        throw error;
    }
}

function removeRestoreState(root: string): void {
    const statePath = getRestoreStateFilePath(root);
    fs.rmSync(statePath, { force: true });
    fsyncDirectory(root);
}

function recoverIncompleteRestore(root: string): void {
    const state = readRestoreState(root);

    if (!state) {
        if (fs.existsSync(getRestoreStateFilePath(root))) {
            throw new EditorDataRestoreIncompleteError(getRestoreStateFilePath(root));
        }

        return;
    }

    if (state.phase === 'replacing') {
        restoreFilesFromBackup(state.files, root, state.backupDirectory);

        for (const directoryPath of state.directories ?? []) {
            restoreDirectoryFromBackup(directoryPath, root, state.backupDirectory);
        }
    }

    fs.rmSync(state.stagingDirectory, { recursive: true, force: true });
    fs.rmSync(state.backupDirectory, { recursive: true, force: true });
    removeRestoreState(root);
    clearEditorDataCache();
}

export function recoverEditorDataRootState(root: string): void {
    recoverIncompleteRestore(root);
    recoverIncompleteManifestTransaction(root);
}

function getEditorDataFiles(root: string): string[] {
    return [
        path.join(root, 'articles', ARTICLES_FILE_NAME),
        path.join(root, 'navigation', NAVIGATION_FILE_NAME),
        path.join(root, 'settings', SETTINGS_FILE_NAME),
        path.join(root, MANIFEST_FILE_NAME),
    ];
}

function copyExistingFiles(files: string[], fromRoot: string, toRoot: string): void {
    for (const filePath of files) {
        if (!fs.existsSync(filePath)) {
            continue;
        }

        const relativePath = path.relative(fromRoot, filePath);
        const backupPath = path.join(toRoot, relativePath);
        ensureParentDirectory(backupPath);
        fs.copyFileSync(filePath, backupPath);
        fsyncFile(backupPath);
    }
}

function restoreFilesFromBackup(files: string[], dataRoot: string, backupRoot: string): void {
    for (const filePath of files) {
        const relativePath = path.relative(dataRoot, filePath);
        const backupPath = path.join(backupRoot, relativePath);

        if (!fs.existsSync(backupPath)) {
            fs.rmSync(filePath, { force: true });
            continue;
        }

        ensureParentDirectory(filePath);
        fs.copyFileSync(backupPath, filePath);
    }
}

function replaceFilesFromStaging(files: string[], dataRoot: string, stagingRoot: string): void {
    for (const filePath of files) {
        const relativePath = path.relative(dataRoot, filePath);
        const stagedPath = path.join(stagingRoot, relativePath);

        if (!fs.existsSync(stagedPath)) {
            throw new Error(`Staged restore file is missing: ${relativePath}`);
        }

        ensureParentDirectory(filePath);
        fs.renameSync(stagedPath, filePath);
    }
}

function copyExistingDirectory(directoryPath: string, fromRoot: string, toRoot: string): void {
    if (!fs.existsSync(directoryPath)) {
        return;
    }

    const relativePath = path.relative(fromRoot, directoryPath);
    const backupPath = path.join(toRoot, relativePath);
    ensureParentDirectory(backupPath);
    fs.cpSync(directoryPath, backupPath, { recursive: true });
}

function restoreDirectoryFromBackup(directoryPath: string, dataRoot: string, backupRoot: string): void {
    const relativePath = path.relative(dataRoot, directoryPath);
    const backupPath = path.join(backupRoot, relativePath);

    fs.rmSync(directoryPath, { recursive: true, force: true });

    if (!fs.existsSync(backupPath)) {
        return;
    }

    ensureParentDirectory(directoryPath);
    fs.cpSync(backupPath, directoryPath, { recursive: true });
}

function replaceDirectoryFromStaging(directoryPath: string, dataRoot: string, stagingRoot: string): void {
    const relativePath = path.relative(dataRoot, directoryPath);
    const stagedPath = path.join(stagingRoot, relativePath);

    if (!fs.existsSync(stagedPath)) {
        throw new Error(`Staged restore directory is missing: ${relativePath}`);
    }

    fs.rmSync(directoryPath, { recursive: true, force: true });
    ensureParentDirectory(directoryPath);
    fs.renameSync(stagedPath, directoryPath);
}

function resolveMediaFilePath(mediaRoot: string, mediaPath: string): string {
    if (!isSafeMediaRelativePath(mediaPath)) {
        throw new Error(`Invalid media path: ${mediaPath}`);
    }

    const filesRoot = path.resolve(mediaRoot, MEDIA_FILES_DIRECTORY_NAME);
    const filePath = path.resolve(mediaRoot, mediaPath);

    if (filePath !== filesRoot && !filePath.startsWith(`${filesRoot}${path.sep}`)) {
        throw new Error(`Invalid media path: ${mediaPath}`);
    }

    return filePath;
}

async function writeRestoredMediaDirectory(mediaRoot: string, media: EditorRestoreMediaData): Promise<void> {
    const filesByPath = new Map((media.files ?? []).map((file) => [file.path, file.bytes]));

    for (const asset of media.manifest.assets) {
        const bytes = filesByPath.get(asset.path) ?? await media.readFile?.(asset.path);

        if (!bytes) {
            throw new Error(`Missing media restore file: ${asset.path}`);
        }

        if (createHash('sha256').update(bytes).digest('hex') !== asset.hash) {
            throw new Error(`Media file hash does not match manifest: ${asset.path}`);
        }

        const filePath = resolveMediaFilePath(mediaRoot, asset.path);
        ensureParentDirectory(filePath);
        fs.writeFileSync(filePath, bytes);
    }

    writeJsonFile(path.join(mediaRoot, MEDIA_MANIFEST_FILE_NAME), {
        version: media.manifest.version,
        updatedAt: new Date().toISOString(),
        assets: media.manifest.assets,
    });
}

function createResourceManifest(value: unknown): EditorDataResourceManifest {
    const hash = createJsonRevision(value);
    const updatedAt = new Date().toISOString();

    return {
        revision: `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-${hash.slice(0, 12)}`,
        hash,
        updatedAt,
    };
}

function createDerivedResourceManifest(value: unknown, hash = createJsonRevision(value)): EditorDataResourceManifest {
    return {
        revision: `derived-${hash}`,
        hash,
        updatedAt: '1970-01-01T00:00:00.000Z',
    };
}

function createManifestForData(data: {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
}): EditorDataManifest {
    const articles = createResourceManifest(data.articles);
    const navigation = createResourceManifest(data.navigation);
    const settings = createResourceManifest(data.settings);

    return {
        version: MANIFEST_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        updatedAt: settings.updatedAt,
        resources: {
            articles,
            navigation,
            settings,
        },
    };
}

function isResourceManifest(value: unknown): value is EditorDataResourceManifest {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<EditorDataResourceManifest>;

    return (
        typeof candidate.revision === 'string' &&
        typeof candidate.hash === 'string' &&
        typeof candidate.updatedAt === 'string'
    );
}

function parseManifest(value: unknown): EditorDataManifest | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as Partial<EditorDataManifest>;

    if (candidate.version !== MANIFEST_VERSION || !candidate.resources) {
        return null;
    }

    if (
        candidate.schemaVersion !== undefined &&
        candidate.schemaVersion !== EDITOR_DATA_SCHEMA_VERSION
    ) {
        return null;
    }

    const resources: EditorDataManifest['resources'] = {};

    for (const resource of ['articles', 'navigation', 'settings'] as const) {
        const manifest = candidate.resources[resource];

        if (isResourceManifest(manifest)) {
            resources[resource] = manifest;
        }
    }

    return {
        version: MANIFEST_VERSION,
        schemaVersion: candidate.schemaVersion === undefined
            ? EDITOR_DATA_SCHEMA_VERSION
            : candidate.schemaVersion,
        updatedAt: typeof candidate.updatedAt === 'string'
            ? candidate.updatedAt
            : new Date().toISOString(),
        resources,
    };
}

export function parseEditorDataManifest(value: unknown): EditorDataManifest | null {
    return parseManifest(value);
}

function createEmptyManifest(): EditorDataManifest {
    return {
        version: MANIFEST_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        resources: {},
    };
}

function getManifestProblems(
    data: {
        articles: Article[];
        navigation: Category[];
        settings: SiteSettings;
    },
    manifest: EditorDataManifest | null
): string[] {
    const problems: string[] = [];

    if (!manifest || manifest.version !== MANIFEST_VERSION) {
        return ['manifest.json is missing or invalid.'];
    }

    const resources = {
        articles: data.articles,
        navigation: data.navigation,
        settings: data.settings,
    };

    for (const resource of ['articles', 'navigation', 'settings'] as const) {
        const resourceManifest = manifest.resources[resource];

        if (!resourceManifest) {
            problems.push(`${resource} manifest is missing.`);
            continue;
        }

        if (resourceManifest.hash !== createJsonRevision(resources[resource])) {
            problems.push(`${resource} hash does not match manifest.`);
        }
    }

    return problems;
}

export function getEditorDataRoot(): string | null {
    return getRuntimeDataRootPath();
}

export function getArticlesDataFilePath(): string | null {
    const root = getEditorDataRoot();
    return root ? path.join(root, 'articles', ARTICLES_FILE_NAME) : null;
}

export function getNavigationDataFilePath(): string | null {
    const root = getEditorDataRoot();
    return root ? path.join(root, 'navigation', NAVIGATION_FILE_NAME) : null;
}

export function getSiteSettingsDataFilePath(): string | null {
    const root = getEditorDataRoot();
    return root ? path.join(root, 'settings', SETTINGS_FILE_NAME) : null;
}

export function getEditorDataManifestFilePath(): string | null {
    const root = getEditorDataRoot();
    return root ? path.join(root, MANIFEST_FILE_NAME) : null;
}

export function readEditorDataManifest(): EditorDataManifest {
    const manifestPath = getEditorDataManifestFilePath();
    const raw = readJsonFile(manifestPath, 'manifest');

    if (raw === null) {
        return createEmptyManifest();
    }

    const manifest = parseManifest(raw);

    if (!manifest && manifestPath) {
        throw createInvalidDataFileError('manifest', manifestPath, 'invalid manifest structure');
    }

    return manifest ?? createEmptyManifest();
}

export async function readEditorDataManifestAsync(): Promise<EditorDataManifest> {
    const manifestPath = getEditorDataManifestFilePath();
    const raw = await readJsonFileAsync(manifestPath, 'manifest');

    if (raw === null) {
        return createEmptyManifest();
    }

    const manifest = parseManifest(raw);

    if (!manifest && manifestPath) {
        throw createInvalidDataFileError('manifest', manifestPath, 'invalid manifest structure');
    }

    return manifest ?? createEmptyManifest();
}

function commitEditorDataResourceWrite(
    resource: EditorDataResourceName,
    resourcePath: string | null,
    value: unknown
): EditorDataResourceManifest {
    if (!resourcePath) {
        throw new EditorDataRootNotConfiguredError();
    }

    const root = getEditorDataRootOrThrow();
    const manifestPath = getEditorDataManifestFilePath();

    if (!manifestPath) {
        throw new EditorDataRootNotConfiguredError();
    }

    const manifest = readEditorDataManifest();
    const previousManifest = manifest.resources[resource] ?? null;
    const resourceManifest = createResourceManifest(value);
    const nextManifest: EditorDataManifest = {
        version: MANIFEST_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        updatedAt: resourceManifest.updatedAt,
        resources: {
            ...manifest.resources,
            [resource]: resourceManifest,
        },
    };

    commitResourceManifestTransaction({
        root,
        resource,
        resourcePath,
        manifestPath,
        resourceValue: value,
        nextManifest,
    });
    setCachedJsonFile(resourcePath, value);
    setCachedJsonFile(manifestPath, nextManifest);
    resetEditorRuntimeCaches();
    if (resource === 'articles') {
        try {
            writeJsonAtomicallyShared(
                path.join(root, 'indexes', 'articles.json'),
                createArticleIndex(value as Article[], resourceManifest.updatedAt)
            );
        } catch (error) {
            console.warn('[editor-data-storage] Failed to refresh article metadata index:', error);
        }
    }
    refreshSearchIndexAfterResourceWrite(resource, value);
    recordContentMutationUnderLock(root, {
        resource,
        revision: resourceManifest.revision,
        digest: resourceManifest.hash,
        value,
    });
    recordEditorAuditEvent({
        action: 'data.write',
        resource,
        outcome: 'success',
        metadata: {
            previousRevision: previousManifest?.revision ?? null,
            revision: resourceManifest.revision,
            hash: resourceManifest.hash,
        },
    });

    return resourceManifest;
}

export function getEditorDataResourceManifest(
    resource: EditorDataResourceName,
    value: unknown
): EditorDataResourceManifest | null {
    const manifest = readEditorDataManifest();
    const resourceManifest = manifest.resources[resource];
    const currentHash = createJsonRevision(value);

    if (resourceManifest?.hash === currentHash) {
        return resourceManifest;
    }

    return createDerivedResourceManifest(value, currentHash);
}

export function createEditorDataManifestSnapshot(data: {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
}): EditorDataManifest {
    const articles = getEditorDataResourceManifest('articles', data.articles);
    const navigation = getEditorDataResourceManifest('navigation', data.navigation);
    const settings = getEditorDataResourceManifest('settings', data.settings);
    const updatedAts = [articles?.updatedAt, navigation?.updatedAt, settings?.updatedAt]
        .filter((value): value is string => typeof value === 'string')
        .sort();
    const updatedAt = updatedAts.length > 0
        ? updatedAts[updatedAts.length - 1]
        : new Date().toISOString();

    return {
        version: MANIFEST_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        updatedAt,
        resources: {
            ...(articles ? { articles } : {}),
            ...(navigation ? { navigation } : {}),
            ...(settings ? { settings } : {}),
        },
    };
}

export function createDerivedEditorDataManifestSnapshot(data: {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
}): EditorDataManifest {
    const articles = createDerivedResourceManifest(data.articles);
    const navigation = createDerivedResourceManifest(data.navigation);
    const settings = createDerivedResourceManifest(data.settings);
    const updatedAts = [articles.updatedAt, navigation.updatedAt, settings.updatedAt].sort();

    return {
        version: MANIFEST_VERSION,
        schemaVersion: EDITOR_DATA_SCHEMA_VERSION,
        updatedAt: updatedAts[updatedAts.length - 1] ?? new Date().toISOString(),
        resources: {
            articles,
            navigation,
            settings,
        },
    };
}

export function getDefaultNavigationSeedFilePath(): string {
    return path.join(
        process.cwd(),
        'content',
        'seeds',
        'navigation',
        'data',
        'tools.json'
    );
}

export function readArticlesFromDisk(): Article[] {
    const articlesPath = getArticlesDataFilePath();
    const raw = readJsonFile(articlesPath, 'articles');

    if (raw === null) {
        return [];
    }

    const articles = parseArticlesData(raw);

    if (!articles && articlesPath) {
        throw createInvalidDataFileError('articles', articlesPath, 'invalid articles structure');
    }

    return articles ?? [];
}

export async function readArticlesFromDiskAsync(): Promise<Article[]> {
    const articlesPath = getArticlesDataFilePath();
    const raw = await readJsonFileAsync(articlesPath, 'articles');

    if (raw === null) {
        return [];
    }

    const articles = parseArticlesData(raw);

    if (!articles && articlesPath) {
        throw createInvalidDataFileError('articles', articlesPath, 'invalid articles structure');
    }

    return articles ?? [];
}

export async function writeArticlesToDisk(articles: Article[]): Promise<EditorDataResourceManifest> {
    return withEditorDataRootLock(() => {
        return commitEditorDataResourceWrite('articles', getArticlesDataFilePath(), articles);
    });
}

export async function writeArticlesToDiskIfRevisionMatches(
    articles: Article[],
    expectedRevision: string | null
): Promise<EditorDataResourceWriteResult<Article[]>> {
    return withEditorDataRootLock(() => {
        const currentValue = readArticlesFromDisk();
        const currentManifest = getEditorDataResourceManifest('articles', currentValue);

        if (!expectedRevision || currentManifest?.revision !== expectedRevision) {
            return {
                success: false,
                currentValue,
                currentManifest,
            };
        }

        assertUniqueArticleSlugs(articles);

        return {
            success: true,
            resourceManifest: commitEditorDataResourceWrite('articles', getArticlesDataFilePath(), articles),
        };
    });
}

export type { ArticlePatchOperation } from '@/lib/article-resource-patch';

export async function patchArticlesToDiskIfRevisionMatches(
    operations: ArticlePatchOperation[],
    expectedRevision: string | null
): Promise<EditorDataResourceWriteResult<Article[]>> {
    return withEditorDataRootLock(() => {
        const currentValue = readArticlesFromDisk();
        const currentManifest = getEditorDataResourceManifest('articles', currentValue);

        if (!expectedRevision || currentManifest?.revision !== expectedRevision) {
            return {
                success: false,
                currentValue,
                currentManifest,
            };
        }

        const nextArticles = applyArticlePatchOperations(currentValue, operations);
        assertUniqueArticleSlugs(nextArticles);

        return {
            success: true,
            resourceManifest: commitEditorDataResourceWrite(
                'articles',
                getArticlesDataFilePath(),
                nextArticles
            ),
        };
    });
}

export function readNavigationFromDisk(): Category[] {
    const navigationPath = getNavigationDataFilePath();
    const raw = readJsonFile(navigationPath, 'navigation');
    const parsed = parseNavigationData(raw);

    if (parsed) {
        return parsed;
    }

    if (raw !== null && navigationPath) {
        throw createInvalidDataFileError('navigation', navigationPath, 'invalid navigation structure');
    }

    const seedPath = getDefaultNavigationSeedFilePath();
    const seedRaw = readJsonFile(seedPath, 'navigation-seed');
    const seedParsed = parseNavigationData(seedRaw);

    if (!seedParsed) {
        if (seedRaw !== null) {
            throw createInvalidDataFileError('navigation-seed', seedPath, 'invalid navigation seed structure');
        }

        return [];
    }

    return seedParsed;
}

export async function readNavigationFromDiskAsync(): Promise<Category[]> {
    const navigationPath = getNavigationDataFilePath();
    const raw = await readJsonFileAsync(navigationPath, 'navigation');
    const parsed = parseNavigationData(raw);

    if (parsed) {
        return parsed;
    }

    if (raw !== null && navigationPath) {
        throw createInvalidDataFileError('navigation', navigationPath, 'invalid navigation structure');
    }

    const seedPath = getDefaultNavigationSeedFilePath();
    const seedRaw = await readJsonFileAsync(seedPath, 'navigation-seed');
    const seedParsed = parseNavigationData(seedRaw);

    if (!seedParsed) {
        if (seedRaw !== null) {
            throw createInvalidDataFileError('navigation-seed', seedPath, 'invalid navigation seed structure');
        }

        return [];
    }

    return seedParsed;
}

export async function writeNavigationToDisk(categories: Category[]): Promise<EditorDataResourceManifest> {
    return withEditorDataRootLock(() => {
        return commitEditorDataResourceWrite('navigation', getNavigationDataFilePath(), categories);
    });
}

export async function writeNavigationToDiskIfRevisionMatches(
    categories: Category[],
    expectedRevision: string | null
): Promise<EditorDataResourceWriteResult<Category[]>> {
    return withEditorDataRootLock(() => {
        const currentValue = readNavigationFromDisk();
        const currentManifest = getEditorDataResourceManifest('navigation', currentValue);

        if (!expectedRevision || currentManifest?.revision !== expectedRevision) {
            return {
                success: false,
                currentValue,
                currentManifest,
            };
        }

        return {
            success: true,
            resourceManifest: commitEditorDataResourceWrite('navigation', getNavigationDataFilePath(), categories),
        };
    });
}

export function readSiteSettingsFromDisk(): SiteSettings {
    const settingsPath = getSiteSettingsDataFilePath();
    const raw = readJsonFile(settingsPath, 'settings');

    if (raw === null) {
        return createDefaultSiteSettings();
    }

    const parsed = parseSiteSettings(raw);

    if (!parsed && settingsPath) {
        throw createInvalidDataFileError('settings', settingsPath, 'invalid site settings structure');
    }

    return parsed ?? createDefaultSiteSettings();
}

export async function readSiteSettingsFromDiskAsync(): Promise<SiteSettings> {
    const settingsPath = getSiteSettingsDataFilePath();
    const raw = await readJsonFileAsync(settingsPath, 'settings');

    if (raw === null) {
        return createDefaultSiteSettings();
    }

    const parsed = parseSiteSettings(raw);

    if (!parsed && settingsPath) {
        throw createInvalidDataFileError('settings', settingsPath, 'invalid site settings structure');
    }

    return parsed ?? createDefaultSiteSettings();
}

export async function writeSiteSettingsToDisk(settings: SiteSettings): Promise<EditorDataResourceManifest> {
    return withEditorDataRootLock(() => {
        return commitEditorDataResourceWrite('settings', getSiteSettingsDataFilePath(), settings);
    });
}

export async function writeSiteSettingsToDiskIfRevisionMatches(
    settings: SiteSettings,
    expectedRevision: string | null
): Promise<EditorDataResourceWriteResult<SiteSettings>> {
    return withEditorDataRootLock(() => {
        const currentValue = readSiteSettingsFromDisk();
        const currentManifest = getEditorDataResourceManifest('settings', currentValue);

        if (!expectedRevision || currentManifest?.revision !== expectedRevision) {
            return {
                success: false,
                currentValue,
                currentManifest,
            };
        }

        return {
            success: true,
            resourceManifest: commitEditorDataResourceWrite('settings', getSiteSettingsDataFilePath(), settings),
        };
    });
}

export async function restoreEditorDataRootAtomically(data: {
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
    media?: EditorRestoreMediaData;
}): Promise<EditorDataManifest> {
    return withEditorDataRootLock(async () => {
        const root = getEditorDataRootOrThrow();
        const stagingRoot = createRestoreDirectory(root, '.restore-staging');
        const backupRoot = createRestoreDirectory(root, '.restore-backup');
        const files = getEditorDataFiles(root);
        const directories = data.media?.files || data.media?.readFile ? [path.join(root, MEDIA_DIRECTORY_NAME)] : [];
        const manifest = createManifestForData(data);
        let backupCaptured = false;
        let restoreStateCreated = false;
        let restoreStateResolved = false;
        let restoreCommitted = false;

        try {
            writeJsonFile(path.join(stagingRoot, 'articles', ARTICLES_FILE_NAME), data.articles);
            writeJsonFile(path.join(stagingRoot, 'navigation', NAVIGATION_FILE_NAME), data.navigation);
            writeJsonFile(path.join(stagingRoot, 'settings', SETTINGS_FILE_NAME), data.settings);
            writeJsonFile(path.join(stagingRoot, MANIFEST_FILE_NAME), manifest);

            if (data.media?.files || data.media?.readFile) {
                await writeRestoredMediaDirectory(path.join(stagingRoot, MEDIA_DIRECTORY_NAME), data.media);
            }

            const stagedArticles = parseArticlesData(readJsonFile(path.join(stagingRoot, 'articles', ARTICLES_FILE_NAME), 'articles'));
            const stagedNavigation = parseNavigationData(readJsonFile(path.join(stagingRoot, 'navigation', NAVIGATION_FILE_NAME), 'navigation'));
            const stagedSettings = parseSiteSettings(readJsonFile(path.join(stagingRoot, 'settings', SETTINGS_FILE_NAME), 'settings'));
            const stagedManifest = parseManifest(readJsonFile(path.join(stagingRoot, MANIFEST_FILE_NAME), 'manifest'));

            if (!stagedArticles || stagedArticles.length !== data.articles.length || !stagedNavigation || !stagedSettings) {
                throw new Error('Staged restore verification failed.');
            }

            const problems = getManifestProblems(
                {
                    articles: stagedArticles,
                    navigation: stagedNavigation,
                    settings: stagedSettings,
                },
                stagedManifest
            );

            if (problems.length > 0) {
                throw new Error(`Staged restore verification failed: ${problems.join('; ')}`);
            }

            copyExistingFiles(files, root, backupRoot);
            for (const directoryPath of directories) {
                copyExistingDirectory(directoryPath, root, backupRoot);
            }
            backupCaptured = true;
            writeRestoreState(root, {
                version: RESTORE_STATE_VERSION,
                phase: 'replacing',
                stagingDirectory: stagingRoot,
                backupDirectory: backupRoot,
                files,
                ...(directories.length > 0 ? { directories } : {}),
                updatedAt: new Date().toISOString(),
            });
            restoreStateCreated = true;
            replaceFilesFromStaging(files, root, stagingRoot);
            for (const directoryPath of directories) {
                replaceDirectoryFromStaging(directoryPath, root, stagingRoot);
            }
            writeRestoreState(root, {
                version: RESTORE_STATE_VERSION,
                phase: 'committed',
                stagingDirectory: stagingRoot,
                backupDirectory: backupRoot,
                files,
                ...(directories.length > 0 ? { directories } : {}),
                updatedAt: new Date().toISOString(),
            });
            restoreCommitted = true;
            restoreStateResolved = true;
            recordRestoredContentMutationUnderLock(root, {
                digest: createJsonRevision({
                    articles: data.articles,
                    navigation: data.navigation,
                    settings: data.settings,
                    media: data.media?.manifest ?? null,
                }),
                value: {
                    articles: data.articles,
                    navigation: data.navigation,
                    settings: data.settings,
                    media: data.media?.manifest ?? null,
                },
            });
            clearEditorDataCache();
            try {
                writeJsonAtomicallyShared(
                    path.join(root, 'indexes', 'articles.json'),
                    createArticleIndex(data.articles, manifest.updatedAt)
                );
                writeSearchIndexForData({
                    articles: data.articles,
                    navigation: data.navigation,
                });
            } catch (error) {
                console.warn('[editor-data-storage] Failed to refresh derived search index after restore:', error);
            }
            recordEditorAuditEvent({
                action: 'data.restore',
                resource: 'editor-data',
                outcome: 'success',
                metadata: {
                    articles: data.articles.length,
                    navigation: data.navigation.length,
                    manifestRevision: manifest.updatedAt,
                },
            });

            return manifest;
        } catch (error) {
            if (backupCaptured && !restoreCommitted) {
                restoreFilesFromBackup(files, root, backupRoot);
                for (const directoryPath of directories) {
                    restoreDirectoryFromBackup(directoryPath, root, backupRoot);
                }
                restoreStateResolved = true;
            }

            throw error;
        } finally {
            if (!restoreStateCreated || restoreStateResolved) {
                fs.rmSync(stagingRoot, { recursive: true, force: true });
                fs.rmSync(backupRoot, { recursive: true, force: true });
                removeRestoreState(root);
            }
        }
    });
}
