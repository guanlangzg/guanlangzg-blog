import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    SESSION_NAMESPACE,
    getEditorAccessToken,
} from '@/lib/editor-auth';
import {
    fsyncDirectory,
    writeJsonAtomically,
} from '@/lib/atomic-json-writer';
import { getRuntimeSettingsFilePath } from '@/lib/runtime-config';
import { isExplicitProductionRuntime, isLocalRuntime } from '@/lib/runtime-environment';
import {
    createEditorPasswordHash,
    MIN_EDITOR_SECRET_LENGTH,
    normalizeEditorSecret,
} from '@/lib/editor-auth-password';

const AUTH_CONFIG_VERSION = 1;
const AUTH_ENV_TOKEN_NAMESPACE = 'blog-navigation-editor-env-token:v1';
const AUTH_CONFIG_FILE_NAME = 'editor-auth.json';
const RUNTIME_SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

interface RuntimeEditorAuthConfig {
    version: typeof AUTH_CONFIG_VERSION;
    passwordSalt: string;
    passwordHash: string;
    activeSessionSalt?: string;
    activeSessionHash?: string;
    activeSessionExpiresAt?: string;
    createdAt: string;
    updatedAt: string;
}

interface EnvironmentEditorSessionState {
    tokenHash: string;
    activeSessionSalt: string;
    activeSessionHash: string;
    activeSessionExpiresAt: string;
}

const ENVIRONMENT_EDITOR_SESSION_GLOBAL_KEY = Symbol.for(
    'blog-navigation-editor-env-session-state'
);

type EnvironmentEditorSessionGlobalState = {
    state: EnvironmentEditorSessionState | null;
};

function getEnvironmentEditorSessionGlobalState(): EnvironmentEditorSessionGlobalState {
    const globalObject = globalThis as typeof globalThis & {
        [ENVIRONMENT_EDITOR_SESSION_GLOBAL_KEY]?: EnvironmentEditorSessionGlobalState;
    };

    if (!globalObject[ENVIRONMENT_EDITOR_SESSION_GLOBAL_KEY]) {
        globalObject[ENVIRONMENT_EDITOR_SESSION_GLOBAL_KEY] = { state: null };
    }

    return globalObject[ENVIRONMENT_EDITOR_SESSION_GLOBAL_KEY];
}

function getEnvironmentEditorSessionFilePath(): string | null {
    return process.env.BLOG_DATA_ROOT?.trim()
        ? getRuntimeSettingsFilePath('editor-env-session.json')
        : null;
}

let environmentEditorSessionState: EnvironmentEditorSessionState | null = null;

export class RuntimeEditorAuthAlreadyConfiguredError extends Error {
    constructor() {
        super('Editor auth is already configured.');
        this.name = 'RuntimeEditorAuthAlreadyConfiguredError';
    }
}

export class RuntimeEditorAuthInvalidSecretError extends Error {
    constructor() {
        super(`Editor secret must be at least ${MIN_EDITOR_SECRET_LENGTH} characters.`);
        this.name = 'RuntimeEditorAuthInvalidSecretError';
    }
}

export class RuntimeEditorAuthConfigInvalidError extends Error {
    constructor(public readonly filePath: string) {
        super('Stored editor auth config is invalid.');
        this.name = 'RuntimeEditorAuthConfigInvalidError';
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

// Password normalization and hashing live in editor-auth-password.ts so the
// admin:init CLI and this runtime verifier cannot drift apart.
const normalizeSecret = normalizeEditorSecret;
const createPasswordHash = createEditorPasswordHash;

function createLegacySessionValue(secret: string): string {
    return sha256(`${SESSION_NAMESPACE}:${normalizeSecret(secret)}`);
}

function createEnvironmentTokenHash(secret: string): string {
    return sha256(`${AUTH_ENV_TOKEN_NAMESPACE}:${normalizeSecret(secret)}`);
}

function createSessionHash(sessionValue: string, salt: string): string {
    return sha256(`${SESSION_NAMESPACE}:${salt}:${sessionValue}`);
}

function createRuntimeEditorSessionFields(sessionValue: string) {
    const activeSessionSalt = randomBytes(16).toString('hex');

    return {
        activeSessionSalt,
        activeSessionHash: createSessionHash(sessionValue, activeSessionSalt),
        activeSessionExpiresAt: new Date(
            Date.now() + RUNTIME_SESSION_MAX_AGE_SECONDS * 1000
        ).toISOString(),
    };
}

function isSessionExpired(expiresAt: string | undefined): boolean {
    if (!expiresAt) {
        return true;
    }

    const expiresAtMs = Date.parse(expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function parseRuntimeEditorAuthConfig(value: unknown, filePath: string): RuntimeEditorAuthConfig {
    if (!value || typeof value !== 'object') {
        throw new RuntimeEditorAuthConfigInvalidError(filePath);
    }

    const candidate = value as Partial<RuntimeEditorAuthConfig>;

    if (
        candidate.version !== AUTH_CONFIG_VERSION ||
        typeof candidate.passwordSalt !== 'string' ||
        typeof candidate.passwordHash !== 'string' ||
        typeof candidate.createdAt !== 'string'
    ) {
        throw new RuntimeEditorAuthConfigInvalidError(filePath);
    }

    return {
        version: AUTH_CONFIG_VERSION,
        passwordSalt: candidate.passwordSalt,
        passwordHash: candidate.passwordHash,
        createdAt: candidate.createdAt,
        updatedAt: typeof candidate.updatedAt === 'string'
            ? candidate.updatedAt
            : candidate.createdAt,
        activeSessionSalt: typeof candidate.activeSessionSalt === 'string'
            ? candidate.activeSessionSalt
            : undefined,
        activeSessionHash: typeof candidate.activeSessionHash === 'string'
            ? candidate.activeSessionHash
            : undefined,
        activeSessionExpiresAt: typeof candidate.activeSessionExpiresAt === 'string'
            ? candidate.activeSessionExpiresAt
            : undefined,
    };
}

export function getRuntimeEditorAuthConfigFilePath(): string {
    const configuredPath = process.env.EDITOR_AUTH_CONFIG_FILE?.trim();

    if (configuredPath) {
        return path.resolve(configuredPath);
    }

    return getRuntimeSettingsFilePath(AUTH_CONFIG_FILE_NAME);
}

export function readRuntimeEditorAuthConfig(): RuntimeEditorAuthConfig | null {
    const filePath = getRuntimeEditorAuthConfigFilePath();

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        return parseRuntimeEditorAuthConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
    } catch (error) {
        if (error instanceof RuntimeEditorAuthConfigInvalidError) {
            throw error;
        }

        console.error(`[editor-auth-runtime] Failed to read auth config: ${filePath}`, error);
        throw new RuntimeEditorAuthConfigInvalidError(filePath);
    }
}

function writeRuntimeEditorAuthConfig(config: RuntimeEditorAuthConfig, mode: 'create' | 'replace'): void {
    const filePath = getRuntimeEditorAuthConfigFilePath();

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (mode === 'replace') {
        writeJsonAtomically(filePath, config, { mode: 0o600 });
        return;
    }

    let fileDescriptor: number | null = null;

    try {
        fileDescriptor = fs.openSync(filePath, 'wx', 0o600);
        fs.writeFileSync(fileDescriptor, JSON.stringify(config, null, 2), 'utf8');
        fs.fsyncSync(fileDescriptor);
    } finally {
        if (fileDescriptor !== null) {
            fs.closeSync(fileDescriptor);
        }
    }

    fsyncDirectory(path.dirname(filePath));
}

export function isRuntimeEditorAuthConfigured(): boolean {
    return Boolean(readRuntimeEditorAuthConfig() || getEditorAccessToken());
}

export async function initializeRuntimeEditorAuth(secret: string): Promise<string> {
    const normalizedSecret = normalizeSecret(secret);

    if (readRuntimeEditorAuthConfig() || getEditorAccessToken()) {
        throw new RuntimeEditorAuthAlreadyConfiguredError();
    }

    if (normalizedSecret.length < MIN_EDITOR_SECRET_LENGTH) {
        throw new RuntimeEditorAuthInvalidSecretError();
    }

    const passwordSalt = randomBytes(16).toString('hex');
    const sessionValue = randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const config: RuntimeEditorAuthConfig = {
        version: AUTH_CONFIG_VERSION,
        passwordSalt,
        passwordHash: await createPasswordHash(normalizedSecret, passwordSalt),
        ...createRuntimeEditorSessionFields(sessionValue),
        createdAt: now,
        updatedAt: now,
    };

    try {
        writeRuntimeEditorAuthConfig(config, 'create');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new RuntimeEditorAuthAlreadyConfiguredError();
        }

        throw error;
    }

    return sessionValue;
}

function parseEnvironmentEditorSessionState(value: unknown): EnvironmentEditorSessionState | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as Partial<EnvironmentEditorSessionState>;

    if (
        typeof candidate.tokenHash !== 'string' ||
        typeof candidate.activeSessionSalt !== 'string' ||
        typeof candidate.activeSessionHash !== 'string' ||
        typeof candidate.activeSessionExpiresAt !== 'string'
    ) {
        return null;
    }

    return {
        tokenHash: candidate.tokenHash,
        activeSessionSalt: candidate.activeSessionSalt,
        activeSessionHash: candidate.activeSessionHash,
        activeSessionExpiresAt: candidate.activeSessionExpiresAt,
    };
}

function isEnvironmentSessionPersistenceError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    return code === 'EACCES' ||
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        code === 'EPERM' ||
        code === 'EROFS';
}

function readEnvironmentEditorSessionState(): EnvironmentEditorSessionState | null {
    if (environmentEditorSessionState) {
        return environmentEditorSessionState;
    }

    const globalState = getEnvironmentEditorSessionGlobalState();

    if (globalState.state) {
        environmentEditorSessionState = globalState.state;
        return environmentEditorSessionState;
    }

    const filePath = getEnvironmentEditorSessionFilePath();

    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        environmentEditorSessionState = parseEnvironmentEditorSessionState(
            JSON.parse(fs.readFileSync(filePath, 'utf8'))
        );
        return environmentEditorSessionState;
    } catch {
        return null;
    }
}

function writeEnvironmentEditorSessionState(state: EnvironmentEditorSessionState): void {
    const filePath = getEnvironmentEditorSessionFilePath();

    getEnvironmentEditorSessionGlobalState().state = state;

    if (!filePath) {
        environmentEditorSessionState = state;
        return;
    }

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        if (!isEnvironmentSessionPersistenceError(error)) {
            throw error;
        }

        console.warn('[editor-auth-runtime] Failed to persist environment session state; using process memory only.', error);
    }

    environmentEditorSessionState = state;
}

function deleteEnvironmentEditorSessionState(): void {
    const filePath = getEnvironmentEditorSessionFilePath();

    environmentEditorSessionState = null;
    getEnvironmentEditorSessionGlobalState().state = null;

    if (filePath) {
        try {
            fs.rmSync(filePath, { force: true });
        } catch (error) {
            if (!isEnvironmentSessionPersistenceError(error)) {
                throw error;
            }
        }
    }
}

export async function createRuntimeEditorSession(): Promise<string | null> {
    const sessionValue = randomBytes(32).toString('hex');
    const config = readRuntimeEditorAuthConfig();

    if (config) {
        const nextConfig: RuntimeEditorAuthConfig = {
            ...config,
            ...createRuntimeEditorSessionFields(sessionValue),
            updatedAt: new Date().toISOString(),
        };

        writeRuntimeEditorAuthConfig(nextConfig, 'replace');
        return sessionValue;
    }

    const envSecret = getEditorAccessToken();

    if (!envSecret) {
        return null;
    }

    writeEnvironmentEditorSessionState({
        tokenHash: createEnvironmentTokenHash(envSecret),
        ...createRuntimeEditorSessionFields(sessionValue),
    });

    return sessionValue;
}

export async function updateRuntimeEditorAuthSecret(secret: string): Promise<string> {
    const normalizedSecret = normalizeSecret(secret);

    if (normalizedSecret.length < MIN_EDITOR_SECRET_LENGTH) {
        throw new RuntimeEditorAuthInvalidSecretError();
    }

    const existingConfig = readRuntimeEditorAuthConfig();
    const passwordSalt = randomBytes(16).toString('hex');
    const sessionValue = randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const config: RuntimeEditorAuthConfig = {
        version: AUTH_CONFIG_VERSION,
        passwordSalt,
        passwordHash: await createPasswordHash(normalizedSecret, passwordSalt),
        ...createRuntimeEditorSessionFields(sessionValue),
        createdAt: existingConfig?.createdAt ?? now,
        updatedAt: now,
    };

    writeRuntimeEditorAuthConfig(config, 'replace');

    return sessionValue;
}

export function revokeRuntimeEditorSession(): void {
    const config = readRuntimeEditorAuthConfig();

    if (!config) {
        if (getEditorAccessToken()) {
            deleteEnvironmentEditorSessionState();
        }

        return;
    }

    const {
        activeSessionSalt: _activeSessionSalt,
        activeSessionHash: _activeSessionHash,
        activeSessionExpiresAt: _activeSessionExpiresAt,
        ...rest
    } = config;

    writeRuntimeEditorAuthConfig({
        ...rest,
        updatedAt: new Date().toISOString(),
    }, 'replace');
}

export async function isValidRuntimeEditorSecret(candidate: string): Promise<boolean> {
    const normalizedCandidate = normalizeSecret(candidate);

    if (!normalizedCandidate) {
        return false;
    }

    const config = readRuntimeEditorAuthConfig();

    if (config) {
        return safeEqual(
            await createPasswordHash(normalizedCandidate, config.passwordSalt),
            config.passwordHash
        );
    }

    const envSecret = getEditorAccessToken();

    return envSecret
        ? safeEqual(createLegacySessionValue(normalizedCandidate), createLegacySessionValue(envSecret))
        : false;
}

export async function isValidRuntimeEditorSession(
    sessionValue: string | null | undefined
): Promise<boolean> {
    if (!sessionValue) {
        return false;
    }

    const config = readRuntimeEditorAuthConfig();

    if (config) {
        if (
            !config.activeSessionSalt ||
            !config.activeSessionHash ||
            isSessionExpired(config.activeSessionExpiresAt)
        ) {
            return false;
        }

        return safeEqual(
            createSessionHash(sessionValue, config.activeSessionSalt),
            config.activeSessionHash
        );
    }

    const envSecret = getEditorAccessToken();

    if (!envSecret) {
        return false;
    }

    const sessionState = readEnvironmentEditorSessionState();

    if (
        !sessionState ||
        isSessionExpired(sessionState.activeSessionExpiresAt) ||
        !safeEqual(sessionState.tokenHash, createEnvironmentTokenHash(envSecret))
    ) {
        return false;
    }

    return safeEqual(
        createSessionHash(sessionValue, sessionState.activeSessionSalt),
        sessionState.activeSessionHash
    );
}

export function resetEnvironmentEditorSessionForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetEnvironmentEditorSessionForTests must not be called in production.');
    }

    environmentEditorSessionState = null;
    getEnvironmentEditorSessionGlobalState().state = null;
}

export function getRuntimeEditorAuthSetupToken(): string | null {
    const token = process.env.EDITOR_RUNTIME_AUTH_SETUP_TOKEN?.trim();
    return token ? token : null;
}

function isRuntimeEditorAuthAlreadyInitialized(): boolean {
    return Boolean(readRuntimeEditorAuthConfig() || getEditorAccessToken());
}

function isUnauthenticatedSetupOptInEnabled(): boolean {
    return process.env.EDITOR_ALLOW_RUNTIME_AUTH_SETUP?.trim() === 'true';
}

// Unauthenticated first-run setup is only safe where the operator has said so.
// Explicit production always demands a setup token. A bare `node server.js`
// deploy (NODE_ENV unset) is treated as production too, so reaching setup there
// requires either a token or an explicit EDITOR_ALLOW_RUNTIME_AUTH_SETUP opt-in.
export function isRuntimeEditorAuthSetupEnabled(): boolean {
    if (isRuntimeEditorAuthAlreadyInitialized()) {
        return false;
    }

    if (isLocalRuntime()) {
        return true;
    }

    if (getRuntimeEditorAuthSetupToken()) {
        return true;
    }

    return !isExplicitProductionRuntime() && isUnauthenticatedSetupOptInEnabled();
}

export function isRuntimeEditorAuthSetupTokenRequired(): boolean {
    return isRuntimeEditorAuthSetupEnabled() && Boolean(getRuntimeEditorAuthSetupToken());
}

export function isValidRuntimeEditorAuthSetupToken(candidate: string): boolean {
    if (!isRuntimeEditorAuthSetupEnabled()) {
        return false;
    }

    const setupToken = getRuntimeEditorAuthSetupToken();

    if (!setupToken) {
        return true;
    }

    return safeEqual(candidate.trim(), setupToken);
}
