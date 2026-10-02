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
    AppRuntimeConfigRevisionMismatchError,
    getEditableAppRuntimeConfig,
    getAppRuntimeConfigRevision,
    getSafeAppRuntimeConfig,
    saveAppRuntimeConfig,
    type EditableAppRuntimeConfig,
} from '@/lib/app-runtime-config';
import { getAppVersionInfo } from '@/lib/app-version';
import {
    createEditorDataRootUnavailableResponse,
    ensureEditorSession,
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import {
    RuntimeEditorAuthInvalidSecretError,
    updateRuntimeEditorAuthSecret,
} from '@/lib/editor-auth-runtime';
import { setEditorSessionCookies } from '@/lib/editor-session-response';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

type RuntimeConfigRequestBody = {
    config?: Partial<Record<keyof EditableAppRuntimeConfig, unknown>>;
    editorSecret?: unknown;
    confirmEditorSecret?: unknown;
    revision?: unknown;
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

function parseRuntimeConfig(value: RuntimeConfigRequestBody['config']): EditableAppRuntimeConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return {
        publicSiteUrl: asString(value.publicSiteUrl),
        cookieSecure: value.cookieSecure === true,
        trustedProxyIps: parseTrustedProxyIps(value.trustedProxyIps),
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

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    try {
        return NextResponse.json({
            config: getSafeAppRuntimeConfig(),
            editable: getEditableAppRuntimeConfig(),
            revision: getAppRuntimeConfigRevision(),
            version: getAppVersionInfo(),
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
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    let body: RuntimeConfigRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<RuntimeConfigRequestBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
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

    if (!config) {
        return NextResponse.json(
            {
                message: '运行时配置格式无效。',
            },
            { status: 400 }
        );
    }

    const editorSecret = asString(body?.editorSecret).trim();
    const confirmEditorSecret = asString(body?.confirmEditorSecret).trim();
    const expectedRevision = typeof body?.revision === 'string' ? body.revision : null;

    if (editorSecret && editorSecret !== confirmEditorSecret) {
        return NextResponse.json(
            {
                message: '两次输入的编辑口令不一致。',
            },
            { status: 400 }
        );
    }

    try {
        let sessionValue: string | null = null;

        await withRuntimeDataRootLock(async () => {
            saveAppRuntimeConfig(config, { expectedRevision });

            if (editorSecret) {
                sessionValue = await updateRuntimeEditorAuthSecret(editorSecret);
            }
        });

        if (!sessionValue) {
            return NextResponse.json({
                success: true,
                config: getSafeAppRuntimeConfig(),
                editable: getEditableAppRuntimeConfig(),
                revision: getAppRuntimeConfigRevision(),
                version: getAppVersionInfo(),
            });
        }

        return setEditorSessionCookies(NextResponse.json({
            success: true,
            config: getSafeAppRuntimeConfig(),
            editable: getEditableAppRuntimeConfig(),
            revision: getAppRuntimeConfigRevision(),
            version: getAppVersionInfo(),
        }), sessionValue);
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
                    message: '编辑口令至少需要 12 个字符。',
                },
                { status: 400 }
            );
        }

        if (error instanceof AppRuntimeConfigRevisionMismatchError) {
            return NextResponse.json(
                {
                    message: '运行时配置已被其他会话更新，请刷新后重试。',
                    config: getSafeAppRuntimeConfig(),
                    editable: getEditableAppRuntimeConfig(),
                    revision: error.currentRevision,
                    version: getAppVersionInfo(),
                },
                { status: 409 }
            );
        }

        const message = error instanceof Error
            ? error.message
            : '运行时配置保存失败。';

        return NextResponse.json({ message }, { status: 400 });
    }
}
