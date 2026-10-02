import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    AppRuntimeConfigInvalidError,
    getEditableAppRuntimeConfig,
    getSafeAppRuntimeConfig,
    saveAppRuntimeConfig,
    type EditableAppRuntimeConfig,
} from '@/lib/app-runtime-config';
import {
    createEditorDataRootUnavailableResponse,
    ensureEditorSession,
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import {
    RuntimeEditorAuthInvalidSecretError,
    initializeRuntimeEditorAuth,
    isRuntimeEditorAuthConfigured,
    isRuntimeEditorAuthSetupEnabled,
    isRuntimeEditorAuthSetupTokenRequired,
    isValidRuntimeEditorAuthSetupToken,
    updateRuntimeEditorAuthSecret,
} from '@/lib/editor-auth-runtime';
import { isValidEditorSecretShape } from '@/lib/editor-auth-password';
import {
    clearEditorAuthFailures,
    getEditorAuthRateLimitResponse,
    recordEditorAuthFailure,
} from '@/lib/editor-auth-rate-limit';
import {
    getEditableR2BackupSettings,
    getR2BackupStatus,
    saveEditableR2BackupSettings,
    type EditableR2BackupSettings,
} from '@/lib/r2-backup-storage';
import {
    CloudflareR2BootstrapError,
    bootstrapCloudflareR2Settings,
    type CloudflareR2BootstrapInput,
} from '@/lib/cloudflare-r2-bootstrap';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { setEditorSessionCookies } from '@/lib/editor-session-response';
import { isApplicationSetupComplete } from '@/lib/setup-state';

type R2SetupMode = 'disabled' | 'manual' | 'cloudflare';

type SetupRequestBody = {
    config?: Partial<Record<keyof EditableAppRuntimeConfig, unknown>>;
    editorSecret?: unknown;
    confirmEditorSecret?: unknown;
    setupToken?: unknown;
    r2SetupMode?: unknown;
    r2Settings?: Partial<Record<keyof EditableR2BackupSettings, unknown>>;
    cloudflareR2Setup?: Partial<Record<keyof CloudflareR2BootstrapInput, unknown>>;
};

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function parseTrustedProxyIps(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => typeof item === 'string' ? item.trim() : '')
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function parseRuntimeConfig(value: SetupRequestBody['config']): EditableAppRuntimeConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return {
        publicSiteUrl: asString(value.publicSiteUrl),
        cookieSecure: value.cookieSecure === true,
        trustedProxyIps: parseTrustedProxyIps(value.trustedProxyIps),
    };
}

function validateRuntimeConfigBeforeExternalSetup(config: EditableAppRuntimeConfig): string | null {
    const publicSiteUrl = config.publicSiteUrl.trim();

    if (publicSiteUrl) {
        try {
            const url = new URL(publicSiteUrl);

            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return '公开站点 URL 必须是有效的 HTTP 或 HTTPS 地址。';
            }
        } catch {
            return '公开站点 URL 必须是有效的 HTTP 或 HTTPS 地址。';
        }
    }

    if (config.trustedProxyIps.some((ip) => ip.includes('\n') || ip.includes('\r') || ip.includes(','))) {
        return '可信代理 IP 请按行填写，不能包含逗号或换行符。';
    }

    return null;
}

function parseR2SetupMode(value: unknown, r2Settings: SetupRequestBody['r2Settings']): R2SetupMode {
    if (value === 'disabled' || value === 'manual' || value === 'cloudflare') {
        return value;
    }

    return r2Settings?.enabled === true ? 'manual' : 'disabled';
}

function createDisabledR2Settings(value: SetupRequestBody['r2Settings']): EditableR2BackupSettings {
    return {
        enabled: false,
        accountId: asString(value?.accountId),
        bucket: asString(value?.bucket),
        accessKeyId: '',
        secretAccessKey: '',
        prefix: asString(value?.prefix) || 'blog-navigation',
        endpoint: asString(value?.endpoint),
        snapshotOnWrite: value?.snapshotOnWrite === true,
    };
}

function parseCloudflareR2Setup(value: SetupRequestBody['cloudflareR2Setup']): CloudflareR2BootstrapInput | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return {
        authEmail: asString(value.authEmail),
        globalApiKey: asString(value.globalApiKey),
        accountId: asString(value.accountId),
        bucket: asString(value.bucket),
        prefix: asString(value.prefix),
        snapshotOnWrite: value.snapshotOnWrite === true,
    };
}

function parseR2Settings(value: SetupRequestBody['r2Settings']): EditableR2BackupSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return {
        enabled: value.enabled === true,
        accountId: asString(value.accountId),
        bucket: asString(value.bucket),
        accessKeyId: asString(value.accessKeyId),
        secretAccessKey: asString(value.secretAccessKey),
        prefix: asString(value.prefix),
        endpoint: asString(value.endpoint),
        snapshotOnWrite: value.snapshotOnWrite === true,
    };
}

function createInvalidRuntimeConfigResponse(error: unknown): NextResponse | null {
    if (!(error instanceof AppRuntimeConfigInvalidError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: '运行时配置文件损坏，请修复或删除后重试。',
        },
        { status: 500 }
    );
}

function createSetupCompletedResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '首次启动引导已完成。',
        },
        { status: 409 }
    );
}

function createAuthStateChangedResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '编辑口令状态已变更，请刷新后重试。',
        },
        { status: 409 }
    );
}

export async function GET(request: NextRequest) {
    try {
        if (isApplicationSetupComplete()) {
            return NextResponse.json({
                setupCompleted: true,
            });
        }

        if (isRuntimeEditorAuthConfigured()) {
            const authError = await ensureEditorSession(request);

            if (authError) {
                return authError;
            }
        }

        return NextResponse.json({
            setupCompleted: false,
            authConfigured: isRuntimeEditorAuthConfigured(),
            setupEnabled: isRuntimeEditorAuthSetupEnabled(),
            setupTokenRequired: isRuntimeEditorAuthSetupTokenRequired(),
            config: getSafeAppRuntimeConfig(),
            editable: getEditableAppRuntimeConfig(),
            r2Settings: getEditableR2BackupSettings(),
            r2Status: getR2BackupStatus(),
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const invalidResponse = createInvalidRuntimeConfigResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}

export async function PUT(request: NextRequest) {
    if (isApplicationSetupComplete()) {
        return createSetupCompletedResponse();
    }

    let body: SetupRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<SetupRequestBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    const config = parseRuntimeConfig(body?.config);
    const r2SetupMode = parseR2SetupMode(body?.r2SetupMode, body?.r2Settings);
    const r2Settings = r2SetupMode === 'manual'
        ? parseR2Settings(body?.r2Settings)
        : createDisabledR2Settings(body?.r2Settings);
    const cloudflareR2Setup = r2SetupMode === 'cloudflare'
        ? parseCloudflareR2Setup(body?.cloudflareR2Setup)
        : null;
    const editorSecret = asString(body?.editorSecret).trim();
    const confirmEditorSecret = asString(body?.confirmEditorSecret).trim();
    const setupToken = asString(body?.setupToken);
    const authConfigured = isRuntimeEditorAuthConfigured();
    const authSetupEnabled = isRuntimeEditorAuthSetupEnabled();

    if (authConfigured) {
        const authError = await ensureEditorWriteRequest(request);

        if (authError) {
            return authError;
        }
    }

    if (!config || !r2Settings || (r2SetupMode === 'cloudflare' && !cloudflareR2Setup)) {
        return NextResponse.json(
            {
                message: '初始化配置格式无效。',
            },
            { status: 400 }
        );
    }

    if (!authConfigured && !authSetupEnabled) {
        return NextResponse.json(
            {
                message: '首次初始化未启用，请先在服务器配置初始化密钥或编辑口令环境变量。',
            },
            { status: 403 }
        );
    }

    if (!authConfigured) {
        const rateLimitResponse = getEditorAuthRateLimitResponse(request, 'setup');

        if (rateLimitResponse) {
            return rateLimitResponse;
        }
    }

    if (isRuntimeEditorAuthSetupTokenRequired() && !isValidRuntimeEditorAuthSetupToken(setupToken)) {
        recordEditorAuthFailure(request, 'setup');
        return NextResponse.json(
            {
                message: '初始化密钥错误。',
            },
            { status: 403 }
        );
    }

    if (!authConfigured && !editorSecret) {
        recordEditorAuthFailure(request, 'setup');
        return NextResponse.json(
            {
                message: '请设置编辑口令。',
            },
            { status: 400 }
        );
    }

    if (editorSecret && editorSecret !== confirmEditorSecret) {
        if (!authConfigured) {
            recordEditorAuthFailure(request, 'setup');
        }

        return NextResponse.json(
            {
                message: '两次输入的编辑口令不一致。',
            },
            { status: 400 }
        );
    }

    if (editorSecret && !isValidEditorSecretShape(editorSecret)) {
        if (!authConfigured) {
            recordEditorAuthFailure(request, 'setup');
        }

        return NextResponse.json(
            {
                message: '编辑口令不符合安全要求。',
            },
            { status: 400 }
        );
    }

    const runtimeConfigError = validateRuntimeConfigBeforeExternalSetup(config);

    if (runtimeConfigError) {
        return NextResponse.json({ message: runtimeConfigError }, { status: 400 });
    }

    try {
        const setupResult = await withRuntimeDataRootLock(async () => {
            if (isApplicationSetupComplete()) {
                return {
                    alreadyComplete: true as const,
                    authStateChanged: false as const,
                    sessionValue: null,
                };
            }

            const authConfiguredAfterLock = isRuntimeEditorAuthConfigured();

            if (!authConfigured && authConfiguredAfterLock) {
                return {
                    alreadyComplete: false as const,
                    authStateChanged: true as const,
                    sessionValue: null,
                };
            }

            if (r2SetupMode === 'cloudflare') {
                await bootstrapCloudflareR2Settings(cloudflareR2Setup as CloudflareR2BootstrapInput);
            } else {
                saveEditableR2BackupSettings(r2Settings);
            }

            let sessionValue: string | null = null;

            if (editorSecret) {
                sessionValue = authConfiguredAfterLock
                    ? await updateRuntimeEditorAuthSecret(editorSecret)
                    : await initializeRuntimeEditorAuth(editorSecret);
            }

            saveAppRuntimeConfig(config, { markSetupComplete: true });

            return {
                alreadyComplete: false as const,
                authStateChanged: false as const,
                sessionValue,
            };
        });

        if (setupResult.alreadyComplete) {
            return createSetupCompletedResponse();
        }

        if (setupResult.authStateChanged) {
            return createAuthStateChangedResponse();
        }

        if (!authConfigured) {
            clearEditorAuthFailures(request, 'setup');
        }

        if (!setupResult.sessionValue) {
            return NextResponse.json({
                success: true,
                config: getSafeAppRuntimeConfig(),
            });
        }

        return setEditorSessionCookies(NextResponse.json({
            success: true,
            config: getSafeAppRuntimeConfig(),
        }), setupResult.sessionValue);
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const invalidResponse = createInvalidRuntimeConfigResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        if (error instanceof RuntimeEditorAuthInvalidSecretError) {
            return NextResponse.json(
                {
                    message: '编辑口令不符合安全要求。',
                },
                { status: 400 }
            );
        }

        if (error instanceof CloudflareR2BootstrapError) {
            return NextResponse.json(
                { message: error.message },
                { status: error.statusCode }
            );
        }

        const message = error instanceof Error
            ? error.message
            : '首次启动初始化失败。';

        return NextResponse.json({ message }, { status: 400 });
    }
}
