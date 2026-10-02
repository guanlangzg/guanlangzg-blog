import {
    GetObjectCommand,
    S3Client,
    S3ServiceException,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { writeJsonAtomically as writeJsonAtomicallyShared } from '@/lib/atomic-json-writer';
import { isRecord } from '@/lib/article-data';
import {
    EDITOR_MEDIA_MAX_IMAGE_BYTES,
    type EditorMediaAsset,
} from '@/lib/editor-media-storage';
import { createJsonRevision } from '@/lib/json-revision';
import { getRuntimeSettingsFilePath } from '@/lib/runtime-config';

const DEFAULT_R2_PREFIX = 'blog-navigation';
const LATEST_BACKUP_FILE_NAME = 'backup.json';
const R2_SETTINGS_FILE_NAME = 'cloudflare-r2.json';
const R2_BACKUP_DOWNLOAD_BODY_LIMIT_BYTES = 128 * 1024 * 1024;
const R2_CONNECTION_TIMEOUT_MS = 5_000;
const R2_REQUEST_TIMEOUT_MS = 30_000;

export interface R2BackupConfig {
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    snapshotOnWrite: boolean;
}

export interface R2BackupStatus {
    enabled: boolean;
    configured: boolean;
    bucket: string | null;
    prefix: string;
    endpoint: string | null;
    snapshotOnWrite: boolean;
    hasAccessKeyId: boolean;
    hasSecretAccessKey: boolean;
    source: 'file' | 'env' | 'default';
    message: string | null;
    securityWarning: string | null;
}

export interface EditableR2BackupSettings {
    enabled: boolean;
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    endpoint: string;
    snapshotOnWrite: boolean;
}

export interface SafeR2BackupSettings extends Omit<EditableR2BackupSettings, 'secretAccessKey' | 'accessKeyId'> {
    hasSecretAccessKey: boolean;
    hasAccessKeyId: boolean;
}

export interface R2UploadResult {
    latestKey: string | null;
    snapshotKey: string | null;
}

export class R2BackupNotConfiguredError extends Error {
    constructor(message = 'Cloudflare R2 backup is not configured.') {
        super(message);
        this.name = 'R2BackupNotConfiguredError';
    }
}

export class R2BackupSettingsInvalidError extends Error {
    constructor(public readonly filePath: string) {
        super('Stored Cloudflare R2 settings are invalid.');
        this.name = 'R2BackupSettingsInvalidError';
    }
}

export class R2BackupPayloadTooLargeError extends Error {
    constructor(public readonly limitBytes = R2_BACKUP_DOWNLOAD_BODY_LIMIT_BYTES) {
        super(`R2 backup payload exceeds ${limitBytes} bytes.`);
        this.name = 'R2BackupPayloadTooLargeError';
    }
}

export class R2BackupSettingsRevisionMismatchError extends Error {
    constructor(public readonly currentRevision: string | null) {
        super('Cloudflare R2 settings revision does not match.');
        this.name = 'R2BackupSettingsRevisionMismatchError';
    }
}

function getEnv(name: string): string {
    return process.env[name]?.trim() ?? '';
}

function getR2SettingsFilePath(): string | null {
    return getRuntimeSettingsFilePath(R2_SETTINGS_FILE_NAME);
}

function parseStoredR2BackupSettings(value: unknown, filePath: string): EditableR2BackupSettings {
    if (!isRecord(value)) {
        throw new R2BackupSettingsInvalidError(filePath);
    }

    if (
        typeof value.enabled !== 'boolean' ||
        typeof value.accountId !== 'string' ||
        typeof value.bucket !== 'string' ||
        typeof value.accessKeyId !== 'string' ||
        typeof value.secretAccessKey !== 'string' ||
        typeof value.prefix !== 'string' ||
        typeof value.endpoint !== 'string' ||
        typeof value.snapshotOnWrite !== 'boolean'
    ) {
        throw new R2BackupSettingsInvalidError(filePath);
    }

    return {
        enabled: value.enabled,
        accountId: value.accountId.trim(),
        bucket: value.bucket.trim(),
        accessKeyId: value.accessKeyId.trim(),
        secretAccessKey: value.secretAccessKey.trim(),
        prefix: value.prefix.trim() || DEFAULT_R2_PREFIX,
        endpoint: value.endpoint.trim(),
        snapshotOnWrite: value.snapshotOnWrite,
    };
}

function readStoredR2BackupSettings(): EditableR2BackupSettings | null {
    const filePath = getR2SettingsFilePath();

    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;

        return parseStoredR2BackupSettings(parsed, filePath);
    } catch (error) {
        if (error instanceof R2BackupSettingsInvalidError) {
            throw error;
        }

        console.error('[r2-backup-storage] Failed to read stored R2 settings:', error);
        throw new R2BackupSettingsInvalidError(filePath);
    }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
    writeJsonAtomicallyShared(filePath, value, { mode: 0o600 });
    protectSecretFile(filePath);
}

function protectSecretFile(filePath: string): void {
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        console.warn('[r2-backup-storage] Failed to tighten R2 settings file permissions:', error);
    }
}

function normalizePrefix(value: string): string {
    return value
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/+/g, '/') || DEFAULT_R2_PREFIX;
}

export function joinR2Key(...parts: string[]): string {
    return parts
        .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
}

function isValidR2AccountId(accountId: string): boolean {
    return /^[a-f0-9]{32}$/i.test(accountId.trim());
}

function createR2Endpoint(accountId: string): string {
    return `https://${accountId}.r2.cloudflarestorage.com`;
}

function resolveR2Endpoint(endpoint: string, accountId: string): string | null {
    const normalizedAccountId = accountId.trim().toLowerCase();

    if (!isValidR2AccountId(normalizedAccountId)) {
        return null;
    }

    const expectedHostname = `${normalizedAccountId}.r2.cloudflarestorage.com`;
    const expectedEndpoint = createR2Endpoint(normalizedAccountId);
    const trimmedEndpoint = endpoint.trim();

    if (!trimmedEndpoint) {
        return expectedEndpoint;
    }

    try {
        const url = new URL(trimmedEndpoint);

        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            url.hostname !== expectedHostname
        ) {
            return null;
        }

        return url.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

export function getEditableR2BackupSettings(): SafeR2BackupSettings {
    const stored = readStoredR2BackupSettings();

    if (stored) {
        return {
            enabled: stored.enabled,
            accountId: stored.accountId,
            bucket: stored.bucket,
            hasAccessKeyId: Boolean(stored.accessKeyId),
            hasSecretAccessKey: Boolean(stored.secretAccessKey),
            prefix: normalizePrefix(stored.prefix || DEFAULT_R2_PREFIX),
            endpoint: stored.endpoint,
            snapshotOnWrite: stored.snapshotOnWrite,
        };
    }

    const enabled = getEnv('R2_BACKUP_ENABLED') === 'true';
    const accountId = getEnv('R2_ACCOUNT_ID');
    const endpoint = getEnv('R2_ENDPOINT');
    const secretAccessKey = getEnv('R2_SECRET_ACCESS_KEY');

    return {
        enabled,
        accountId,
        bucket: getEnv('R2_BUCKET'),
        hasAccessKeyId: Boolean(getEnv('R2_ACCESS_KEY_ID')),
        hasSecretAccessKey: Boolean(secretAccessKey),
        prefix: normalizePrefix(getEnv('R2_PREFIX') || DEFAULT_R2_PREFIX),
        endpoint,
        snapshotOnWrite: getEnv('R2_SNAPSHOT_ON_WRITE') === 'true',
    };
}

function createR2BackupSettingsRevision(settings: EditableR2BackupSettings | null): string | null {
    return settings ? createJsonRevision(settings) : null;
}

export function getR2BackupSettingsRevision(): string | null {
    return createR2BackupSettingsRevision(readStoredR2BackupSettings());
}

export function saveEditableR2BackupSettings(
    input: EditableR2BackupSettings,
    options: { expectedRevision?: string | null } = {}
): SafeR2BackupSettings {
    const filePath = getR2SettingsFilePath();

    if (!filePath) {
        throw new Error('Runtime data root is not configured.');
    }

    let existing: EditableR2BackupSettings | null = null;
    let currentRevision: string | null = null;

    try {
        existing = readStoredR2BackupSettings();
        currentRevision = createR2BackupSettingsRevision(existing);
    } catch (error) {
        const canReplaceInvalidSettings = (
            error instanceof R2BackupSettingsInvalidError &&
            (!input.enabled || input.secretAccessKey.trim().length > 0)
        );

        if (!canReplaceInvalidSettings) {
            throw error;
        }
    }

    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new R2BackupSettingsRevisionMismatchError(currentRevision);
    }

    const trimmedSecretAccessKey = input.secretAccessKey.trim();

    const nextSettings: EditableR2BackupSettings = {
        enabled: input.enabled,
        accountId: input.accountId.trim(),
        bucket: input.bucket.trim(),
        accessKeyId: input.accessKeyId.trim(),
        secretAccessKey: trimmedSecretAccessKey || existing?.secretAccessKey || (input.enabled ? getEnv('R2_SECRET_ACCESS_KEY') : ''),
        prefix: normalizePrefix(input.prefix || DEFAULT_R2_PREFIX),
        endpoint: input.endpoint.trim(),
        snapshotOnWrite: input.snapshotOnWrite,
    };

    if (
        nextSettings.enabled &&
        (!nextSettings.accountId || !nextSettings.bucket || !nextSettings.accessKeyId || !nextSettings.secretAccessKey)
    ) {
        throw new Error('启用 R2 备份时必须填写 Account ID、Bucket、Access Key ID 和 Secret Access Key。');
    }

    if (nextSettings.enabled && !resolveR2Endpoint(nextSettings.endpoint, nextSettings.accountId)) {
        throw new Error('Cloudflare R2 Endpoint 必须是当前 Account ID 对应的 HTTPS R2 地址。');
    }

    writeJsonAtomically(filePath, nextSettings);

    return getEditableR2BackupSettings();
}

export function getR2BackupConfig(): R2BackupConfig | null {
    const stored = readStoredR2BackupSettings();
    const enabled = stored ? stored.enabled : getEnv('R2_BACKUP_ENABLED') === 'true';

    if (!enabled) {
        return null;
    }

    const accountId = stored ? stored.accountId : getEnv('R2_ACCOUNT_ID');
    const bucket = stored ? stored.bucket : getEnv('R2_BUCKET');
    const accessKeyId = stored ? stored.accessKeyId : getEnv('R2_ACCESS_KEY_ID');
    const secretAccessKey = stored ? stored.secretAccessKey : getEnv('R2_SECRET_ACCESS_KEY');
    const endpoint = resolveR2Endpoint(stored ? stored.endpoint : getEnv('R2_ENDPOINT'), accountId);

    if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !endpoint) {
        return null;
    }

    return {
        bucket,
        endpoint,
        accessKeyId,
        secretAccessKey,
        prefix: normalizePrefix(stored ? stored.prefix : getEnv('R2_PREFIX') || DEFAULT_R2_PREFIX),
        snapshotOnWrite: stored
            ? Boolean(stored.snapshotOnWrite)
            : getEnv('R2_SNAPSHOT_ON_WRITE') === 'true',
    };
}

export function getR2BackupStatus(): R2BackupStatus {
    const stored = readStoredR2BackupSettings();
    const enabled = stored ? stored.enabled : getEnv('R2_BACKUP_ENABLED') === 'true';
    const config = getR2BackupConfig();
    const settings = getEditableR2BackupSettings();
    const hasRequiredConnectionSettings = Boolean(
        settings.accountId &&
        settings.bucket &&
        settings.hasAccessKeyId &&
        settings.hasSecretAccessKey &&
        resolveR2Endpoint(settings.endpoint, settings.accountId)
    );

    return {
        enabled,
        configured: Boolean(config),
        bucket: config?.bucket ?? (settings.bucket || null),
        prefix: config?.prefix ?? settings.prefix,
        endpoint: config?.endpoint ?? (settings.endpoint || null),
        snapshotOnWrite: settings.snapshotOnWrite,
        hasAccessKeyId: settings.hasAccessKeyId,
        hasSecretAccessKey: settings.hasSecretAccessKey,
        source: stored ? 'file' : (enabled || settings.bucket || settings.accountId ? 'env' : 'default'),
        message: enabled && !config && !hasRequiredConnectionSettings
            ? 'R2 backup is enabled but required variables are missing.'
            : null,
        securityWarning: enabled && config
            ? 'R2 backups are stored as plaintext JSON in Cloudflare R2.'
            : null,
    };
}

let cachedR2Client: S3Client | null = null;
let cachedR2ClientKey: string | null = null;

export function createR2Client(config: R2BackupConfig): S3Client {
    const secretHash = createHash('sha256').update(config.secretAccessKey).digest('hex').slice(0, 16);
    const cacheKey = `${config.endpoint}|${config.accessKeyId}|${secretHash}`;

    if (cachedR2Client && cachedR2ClientKey === cacheKey) {
        return cachedR2Client;
    }

    cachedR2Client = new S3Client({
        region: 'auto',
        endpoint: config.endpoint,
        forcePathStyle: true,
        requestHandler: new NodeHttpHandler({
            connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
            requestTimeout: R2_REQUEST_TIMEOUT_MS,
        }),
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
    cachedR2ClientKey = cacheKey;

    return cachedR2Client;
}

function createLatestBackupKey(config: R2BackupConfig): string {
    return joinR2Key(config.prefix, 'latest', LATEST_BACKUP_FILE_NAME);
}

function assertR2BackupDownloadBodySize(byteLength: number): void {
    if (byteLength > R2_BACKUP_DOWNLOAD_BODY_LIMIT_BYTES) {
        throw new R2BackupPayloadTooLargeError(R2_BACKUP_DOWNLOAD_BODY_LIMIT_BYTES);
    }
}

function assertR2BackupDownloadBodyTextSize(value: string): void {
    assertR2BackupDownloadBodySize(Buffer.byteLength(value, 'utf8'));
}

export async function bodyToString(body: unknown): Promise<string> {
    if (!body) {
        return '';
    }

    if (typeof body === 'string') {
        assertR2BackupDownloadBodyTextSize(body);
        return body;
    }

    if (body instanceof Uint8Array) {
        assertR2BackupDownloadBodySize(body.byteLength);
        return Buffer.from(body).toString('utf8');
    }

    if (typeof body === 'object' && 'transformToString' in body) {
        const value = await (body as { transformToString: () => Promise<string> }).transformToString();
        assertR2BackupDownloadBodyTextSize(value);
        return value;
    }

    if (Symbol.asyncIterator in Object(body)) {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            receivedBytes += buffer.byteLength;
            assertR2BackupDownloadBodySize(receivedBytes);
            chunks.push(buffer);
        }

        return Buffer.concat(chunks).toString('utf8');
    }

    const value = String(body);
    assertR2BackupDownloadBodyTextSize(value);
    return value;
}

export async function bodyToBytes(body: unknown, limitBytes: number): Promise<Uint8Array> {
    if (!body) {
        return new Uint8Array();
    }

    if (body instanceof Uint8Array) {
        if (body.byteLength > limitBytes) {
            throw new R2BackupPayloadTooLargeError(limitBytes);
        }

        return body;
    }

    if (typeof body === 'string') {
        const buffer = Buffer.from(body, 'binary');

        if (buffer.byteLength > limitBytes) {
            throw new R2BackupPayloadTooLargeError(limitBytes);
        }

        return buffer;
    }

    if (typeof body === 'object' && 'transformToByteArray' in body) {
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();

        if (bytes.byteLength > limitBytes) {
            throw new R2BackupPayloadTooLargeError(limitBytes);
        }

        return bytes;
    }

    if (Symbol.asyncIterator in Object(body)) {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            receivedBytes += buffer.byteLength;

            if (receivedBytes > limitBytes) {
                throw new R2BackupPayloadTooLargeError(limitBytes);
            }

            chunks.push(buffer);
        }

        return Buffer.concat(chunks);
    }

    const buffer = Buffer.from(String(body), 'binary');

    if (buffer.byteLength > limitBytes) {
        throw new R2BackupPayloadTooLargeError(limitBytes);
    }

    return buffer;
}

function parseR2BackupBody(content: string): unknown {
    return JSON.parse(content) as unknown;
}

export async function downloadLatestBackupPayloadFromR2(): Promise<unknown> {
    const config = getR2BackupConfig();

    if (!config) {
        throw new R2BackupNotConfiguredError();
    }

    const client = createR2Client(config);
    const latestKey = createLatestBackupKey(config);

    try {
        const response = await client.send(
            new GetObjectCommand({
                Bucket: config.bucket,
                Key: latestKey,
            })
        );

        if (typeof response.ContentLength === 'number') {
            assertR2BackupDownloadBodySize(response.ContentLength);
        }

        const content = await bodyToString(response.Body);

        return parseR2BackupBody(content);
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('Latest R2 backup is not valid JSON.');
        }

        if (error instanceof S3ServiceException && error.name === 'NoSuchKey') {
            throw new Error(`Latest R2 backup was not found at ${latestKey}.`);
        }

        throw error;
    }
}

function createMediaObjectKey(config: R2BackupConfig, asset: EditorMediaAsset): string {
    return joinR2Key(config.prefix, 'media', asset.path);
}

export async function downloadMediaAssetFromR2(asset: EditorMediaAsset): Promise<Uint8Array> {
    const config = getR2BackupConfig();

    if (!config) {
        throw new R2BackupNotConfiguredError();
    }

    const client = createR2Client(config);
    const key = createMediaObjectKey(config, asset);

    const response = await client.send(
        new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
        })
    );

    if (typeof response.ContentLength === 'number' && response.ContentLength > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
        throw new R2BackupPayloadTooLargeError(EDITOR_MEDIA_MAX_IMAGE_BYTES);
    }

    return bodyToBytes(response.Body, EDITOR_MEDIA_MAX_IMAGE_BYTES);
}
