import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '@/lib/article-data';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { registerEditorRuntimeCacheReset } from '@/lib/editor-runtime-cache';
import { createJsonRevision } from '@/lib/json-revision';
import {
    getRuntimeDataRoot,
    getRuntimeDataRootPath,
    getRuntimeSettingsFilePath,
} from '@/lib/runtime-config';

const APP_RUNTIME_CONFIG_FILE_NAME = 'app-runtime.json';
const APP_RUNTIME_CONFIG_VERSION = 1;
const DEFAULT_PUBLIC_SITE_URL = 'http://localhost:3000';

export type RuntimeConfigSource = 'file' | 'env' | 'default';
export type RuntimeConfigEffect = 'hot' | 'hot-server' | 'next-session' | 'restart-required';

export interface AppRuntimeDataRootConfig {
    path: string;
    pendingPath: string | null;
    requiresRestart: boolean;
}

export interface AppRuntimeConfig {
    version: typeof APP_RUNTIME_CONFIG_VERSION;
    setupCompletedAt: string | null;
    publicSiteUrl: string;
    cookieSecure: boolean;
    trustedProxyIps: string[];
    dataRoot: AppRuntimeDataRootConfig;
    updatedAt: string;
}

export interface EditableAppRuntimeConfig {
    publicSiteUrl: string;
    cookieSecure: boolean;
    trustedProxyIps: string[];
}

export interface SafeAppRuntimeConfig {
    setupCompleted: boolean;
    setupCompletedAt: string | null;
    publicSiteUrl: {
        value: string;
        source: RuntimeConfigSource;
        effect: 'hot-server';
    };
    cookieSecure: {
        value: boolean;
        source: RuntimeConfigSource;
        effect: 'next-session';
    };
    trustedProxyIps: {
        value: string[];
        source: RuntimeConfigSource;
        effect: 'hot';
    };
    dataRoot: {
        path: string;
        pendingPath: string | null;
        requiresRestart: boolean;
        source: RuntimeConfigSource;
        effect: 'restart-required';
    };
}

export class AppRuntimeConfigInvalidError extends Error {
    constructor(public readonly filePath: string) {
        super('Stored app runtime config is invalid.');
        this.name = 'AppRuntimeConfigInvalidError';
    }
}

export class AppRuntimeConfigRevisionMismatchError extends Error {
    constructor(public readonly currentRevision: string | null) {
        super('App runtime config revision does not match.');
        this.name = 'AppRuntimeConfigRevisionMismatchError';
    }
}

let appRuntimeConfigCache: {
    filePath: string;
    mtimeMs: number;
    size: number;
    value: AppRuntimeConfig | null;
} | null = null;

function getEnv(name: string): string {
    return process.env[name]?.trim() ?? '';
}

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    return normalizeString(value);
}

function normalizeBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function normalizeTrustedProxyIps(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const ips = value
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean);

    return ips.some((ip) => ip.includes('\n') || ip.includes('\r')) ? null : ips;
}

function parseTrustedProxyIpsEnv(value: string): string[] {
    return value
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean);
}

function normalizePublicSiteUrl(value: string): string | null {
    const trimmed = value.trim();

    if (!trimmed) {
        return '';
    }

    try {
        const url = new URL(trimmed);

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }

        url.pathname = url.pathname.replace(/\/+$/, '');
        url.search = '';
        url.hash = '';

        return url.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function normalizeDataRootPath(value: string): string {
    const trimmed = value.trim();

    return trimmed ? path.resolve(trimmed) : getRuntimeDataRootPath();
}

function getEnvPublicSiteUrl(): string {
    const configured = getEnv('NEXT_PUBLIC_SITE_URL');

    if (configured) {
        return configured;
    }

    const vercelUrl = getEnv('VERCEL_URL');
    return vercelUrl ? `https://${vercelUrl}` : '';
}

function getDefaultCookieSecure(): boolean {
    const configured = getEnv('COOKIE_SECURE');

    if (configured === 'true') {
        return true;
    }

    if (configured === 'false') {
        return false;
    }

    return process.env.NODE_ENV === 'production';
}

function createConfigFromSources(stored: AppRuntimeConfig | null): SafeAppRuntimeConfig {
    const dataRoot = getRuntimeDataRoot();
    const envPublicSiteUrl = normalizePublicSiteUrl(getEnvPublicSiteUrl());
    const storedPublicSiteUrl = stored ? normalizePublicSiteUrl(stored.publicSiteUrl) : null;
    const publicSiteUrl = storedPublicSiteUrl ?? envPublicSiteUrl ?? DEFAULT_PUBLIC_SITE_URL;
    const publicSiteUrlSource: RuntimeConfigSource = storedPublicSiteUrl !== null
        ? 'file'
        : envPublicSiteUrl
            ? 'env'
            : 'default';
    const envTrustedProxyIps = parseTrustedProxyIpsEnv(getEnv('TRUSTED_PROXY_IPS'));
    const trustedProxyIps = stored ? stored.trustedProxyIps : envTrustedProxyIps;
    const trustedProxyIpsSource: RuntimeConfigSource = stored
        ? 'file'
        : envTrustedProxyIps.length > 0
            ? 'env'
            : 'default';

    return {
        setupCompleted: Boolean(stored?.setupCompletedAt),
        setupCompletedAt: stored?.setupCompletedAt ?? null,
        publicSiteUrl: {
            value: publicSiteUrl || DEFAULT_PUBLIC_SITE_URL,
            source: publicSiteUrlSource,
            effect: 'hot-server',
        },
        cookieSecure: {
            value: stored ? stored.cookieSecure : getDefaultCookieSecure(),
            source: stored ? 'file' : getEnv('COOKIE_SECURE') ? 'env' : 'default',
            effect: 'next-session',
        },
        trustedProxyIps: {
            value: trustedProxyIps,
            source: trustedProxyIpsSource,
            effect: 'hot',
        },
        dataRoot: {
            path: stored?.dataRoot.path || dataRoot.path,
            pendingPath: stored?.dataRoot.pendingPath ?? null,
            requiresRestart: Boolean(stored?.dataRoot.requiresRestart),
            source: dataRoot.source,
            effect: 'restart-required',
        },
    };
}

function parseStoredAppRuntimeConfig(value: unknown, filePath: string): AppRuntimeConfig {
    if (!isRecord(value)) {
        throw new AppRuntimeConfigInvalidError(filePath);
    }

    const dataRoot = isRecord(value.dataRoot) ? value.dataRoot : null;
    const trustedProxyIps = normalizeTrustedProxyIps(value.trustedProxyIps);
    const cookieSecure = normalizeBoolean(value.cookieSecure);
    const publicSiteUrl = typeof value.publicSiteUrl === 'string'
        ? normalizePublicSiteUrl(value.publicSiteUrl)
        : null;
    const dataRootPath = dataRoot && typeof dataRoot.path === 'string'
        ? normalizeDataRootPath(dataRoot.path)
        : null;
    const pendingPath = dataRoot
        ? normalizeOptionalString(dataRoot.pendingPath)
        : null;
    const requiresRestart = dataRoot
        ? normalizeBoolean(dataRoot.requiresRestart)
        : null;

    if (
        value.version !== APP_RUNTIME_CONFIG_VERSION ||
        publicSiteUrl === null ||
        cookieSecure === null ||
        trustedProxyIps === null ||
        !dataRootPath ||
        requiresRestart === null ||
        typeof value.updatedAt !== 'string'
    ) {
        throw new AppRuntimeConfigInvalidError(filePath);
    }

    return {
        version: APP_RUNTIME_CONFIG_VERSION,
        setupCompletedAt: normalizeOptionalString(value.setupCompletedAt),
        publicSiteUrl,
        cookieSecure,
        trustedProxyIps,
        dataRoot: {
            path: dataRootPath,
            pendingPath: pendingPath ? normalizeDataRootPath(pendingPath) : null,
            requiresRestart,
        },
        updatedAt: value.updatedAt,
    };
}

export function getAppRuntimeConfigFilePath(): string {
    return getRuntimeSettingsFilePath(APP_RUNTIME_CONFIG_FILE_NAME);
}

export function readStoredAppRuntimeConfig(): AppRuntimeConfig | null {
    const filePath = getAppRuntimeConfigFilePath();

    if (!fs.existsSync(filePath)) {
        appRuntimeConfigCache = {
            filePath,
            mtimeMs: 0,
            size: 0,
            value: null,
        };
        return null;
    }

    const stats = fs.statSync(filePath);
    const cached = appRuntimeConfigCache;

    if (
        cached &&
        cached.filePath === filePath &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
    ) {
        return cached.value;
    }

    try {
        const parsed = parseStoredAppRuntimeConfig(
            JSON.parse(fs.readFileSync(filePath, 'utf8')),
            filePath
        );

        appRuntimeConfigCache = {
            filePath,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            value: parsed,
        };
        return parsed;
    } catch (error) {
        if (error instanceof AppRuntimeConfigInvalidError) {
            throw error;
        }

        console.error(`[app-runtime-config] Failed to read config: ${filePath}`, error);
        throw new AppRuntimeConfigInvalidError(filePath);
    }
}

export function getSafeAppRuntimeConfig(): SafeAppRuntimeConfig {
    return createConfigFromSources(readStoredAppRuntimeConfig());
}

export function getEditableAppRuntimeConfig(): EditableAppRuntimeConfig {
    const config = getSafeAppRuntimeConfig();

    return {
        publicSiteUrl: config.publicSiteUrl.value,
        cookieSecure: config.cookieSecure.value,
        trustedProxyIps: config.trustedProxyIps.value,
    };
}

function createAppRuntimeConfigRevision(config: AppRuntimeConfig | null): string | null {
    return config ? createJsonRevision(config) : null;
}

export function getAppRuntimeConfigRevision(): string | null {
    return createAppRuntimeConfigRevision(readStoredAppRuntimeConfig());
}

export function saveAppRuntimeConfig(
    input: EditableAppRuntimeConfig,
    options: { markSetupComplete?: boolean; expectedRevision?: string | null } = {}
): AppRuntimeConfig {
    const existing = readStoredAppRuntimeConfig();
    const currentRevision = createAppRuntimeConfigRevision(existing);

    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new AppRuntimeConfigRevisionMismatchError(currentRevision);
    }

    const normalizedPublicSiteUrl = normalizePublicSiteUrl(input.publicSiteUrl);

    if (normalizedPublicSiteUrl === null) {
        throw new Error('公开站点 URL 必须是有效的 HTTP 或 HTTPS 地址。');
    }

    if (input.trustedProxyIps.some((ip) => ip.includes('\n') || ip.includes('\r') || ip.includes(','))) {
        throw new Error('可信代理 IP 请按行填写，不能包含逗号或换行符。');
    }

    const now = new Date().toISOString();
    const activeDataRoot = getRuntimeDataRootPath();
    const nextConfig: AppRuntimeConfig = {
        version: APP_RUNTIME_CONFIG_VERSION,
        setupCompletedAt: options.markSetupComplete
            ? existing?.setupCompletedAt ?? now
            : existing?.setupCompletedAt ?? null,
        publicSiteUrl: normalizedPublicSiteUrl,
        cookieSecure: input.cookieSecure,
        trustedProxyIps: [...input.trustedProxyIps],
        dataRoot: {
            // dataRootPath editing was removed; the active data root always
            // matches the env/Docker/cwd resolution, so no pending change exists.
            path: path.resolve(activeDataRoot),
            pendingPath: null,
            requiresRestart: false,
        },
        updatedAt: now,
    };
    const filePath = getAppRuntimeConfigFilePath();

    writeJsonAtomically(filePath, nextConfig);
    appRuntimeConfigCache = null;

    return readStoredAppRuntimeConfig() ?? nextConfig;
}

export function getRuntimePublicSiteUrl(): string {
    return getSafeAppRuntimeConfig().publicSiteUrl.value;
}

export function getRuntimeCookieSecure(): boolean {
    return getSafeAppRuntimeConfig().cookieSecure.value;
}

export function getRuntimeTrustedProxyIps(): string[] {
    return getSafeAppRuntimeConfig().trustedProxyIps.value;
}

export function resetAppRuntimeConfigCacheForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetAppRuntimeConfigCacheForTests must not be called in production.');
    }

    appRuntimeConfigCache = null;
}

registerEditorRuntimeCacheReset(() => {
    appRuntimeConfigCache = null;
});
