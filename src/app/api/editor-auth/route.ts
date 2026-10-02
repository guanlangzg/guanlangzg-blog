import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_AUTH_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    EDITOR_SESSION_COOKIE,
    getEditorAccessToken,
} from '@/lib/editor-auth';
import {
    createEditorAuthConfigInvalidResponse,
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import {
    RuntimeEditorAuthAlreadyConfiguredError,
    RuntimeEditorAuthInvalidSecretError,
    createRuntimeEditorSession,
    initializeRuntimeEditorAuth,
    isRuntimeEditorAuthConfigured,
    isRuntimeEditorAuthSetupEnabled,
    isRuntimeEditorAuthSetupTokenRequired,
    isValidRuntimeEditorAuthSetupToken,
    isValidRuntimeEditorSecret,
    isValidRuntimeEditorSession,
    readRuntimeEditorAuthConfig,
    revokeRuntimeEditorSession,
} from '@/lib/editor-auth-runtime';
import {
    clearEditorSessionCookie,
    createEditorSessionResponse,
} from '@/lib/editor-session-response';
import {
    clearEditorAuthFailures,
    getEditorAuthRateLimitResponse,
    recordEditorAuthFailure,
} from '@/lib/editor-auth-rate-limit';
import { recordEditorAuditEvent } from '@/lib/editor-audit-log';

export async function GET(request: NextRequest) {
    try {
        const session = request.cookies.get(EDITOR_SESSION_COOKIE)?.value;

        return NextResponse.json({
            configured: isRuntimeEditorAuthConfigured(),
            authenticated: await isValidRuntimeEditorSession(session),
            setupEnabled: isRuntimeEditorAuthSetupEnabled(),
            setupTokenRequired: isRuntimeEditorAuthSetupTokenRequired(),
        });
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}

export async function POST(request: NextRequest) {
    try {
        if (!isRuntimeEditorAuthConfigured()) {
            return NextResponse.json(
                {
                    message: '未初始化编辑口令，请先完成首次初始化。',
                },
                { status: 503 }
            );
        }

        const rateLimitResponse = getEditorAuthRateLimitResponse(request, 'login');

        if (rateLimitResponse) {
            return rateLimitResponse;
        }

        const body = await readJsonBodyWithLimit<{ secret?: unknown }>(
            request,
            EDITOR_AUTH_JSON_BODY_LIMIT_BYTES
        ).catch((error: unknown) => {
            if (error instanceof JsonBodyTooLargeError) {
                return error;
            }

            if (error instanceof JsonBodyParseError) {
                return error;
            }

            throw error;
        });

        if (body instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (body instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        const secret = typeof body?.secret === 'string' ? body.secret : '';

        if (!(await isValidRuntimeEditorSecret(secret))) {
            recordEditorAuthFailure(request, 'login');
            recordEditorAuditEvent({
                action: 'auth.login.failure',
                resource: 'editor-auth',
                outcome: 'failure',
                message: 'invalid_secret',
            });
            return NextResponse.json(
                {
                    message: '口令错误。',
                },
                { status: 401 }
            );
        }

        clearEditorAuthFailures(request, 'login');
        const sessionValue = await createRuntimeEditorSession();

        if (!sessionValue) {
            return NextResponse.json(
                {
                    message: '未初始化编辑口令，请先完成首次初始化。',
                },
                { status: 503 }
            );
        }

        recordEditorAuditEvent({
            action: 'auth.login.success',
            resource: 'editor-auth',
            outcome: 'success',
        });
        return createEditorSessionResponse(sessionValue);
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}

export async function PUT(request: NextRequest) {
    try {
        if (!getEditorAccessToken()) {
            readRuntimeEditorAuthConfig();
        }
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }

    const body = await readJsonBodyWithLimit<{
        secret?: unknown;
        confirmSecret?: unknown;
        setupToken?: unknown;
    }>(request, EDITOR_AUTH_JSON_BODY_LIMIT_BYTES).catch((error: unknown) => {
        if (error instanceof JsonBodyTooLargeError) {
            return error;
        }

        if (error instanceof JsonBodyParseError) {
            return error;
        }

        throw error;
    });

    if (body instanceof JsonBodyTooLargeError) {
        return createJsonBodyTooLargeResponse();
    }

    if (body instanceof JsonBodyParseError) {
        return createJsonBodyParseErrorResponse();
    }

    const secret = typeof body?.secret === 'string' ? body.secret : '';
    const confirmSecret = typeof body?.confirmSecret === 'string' ? body.confirmSecret : '';
    const setupToken = typeof body?.setupToken === 'string' ? body.setupToken : '';

    if (isRuntimeEditorAuthConfigured()) {
        return NextResponse.json(
            {
                message: '编辑口令已初始化，请直接登录。',
            },
            { status: 409 }
        );
    }

    if (!isRuntimeEditorAuthSetupEnabled()) {
        return NextResponse.json(
            {
                message: '首次初始化未启用，请先在服务器配置初始化密钥。',
            },
            { status: 403 }
        );
    }

    const rateLimitResponse = getEditorAuthRateLimitResponse(request, 'setup');

    if (rateLimitResponse) {
        return rateLimitResponse;
    }

    if (!isValidRuntimeEditorAuthSetupToken(setupToken)) {
        recordEditorAuthFailure(request, 'setup');
        return NextResponse.json(
            {
                message: '初始化密钥错误。',
            },
            { status: 403 }
        );
    }

    if (!secret.trim() || secret.trim() !== confirmSecret.trim()) {
        recordEditorAuthFailure(request, 'setup');
        return NextResponse.json(
            {
                message: '两次输入的编辑口令不一致。',
            },
            { status: 400 }
        );
    }

    try {
        const sessionValue = await initializeRuntimeEditorAuth(secret);
        clearEditorAuthFailures(request, 'setup');
        recordEditorAuditEvent({
            action: 'auth.setup.success',
            resource: 'editor-auth',
            outcome: 'success',
        });
        return createEditorSessionResponse(sessionValue);
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        if (error instanceof RuntimeEditorAuthAlreadyConfiguredError) {
            return NextResponse.json(
                {
                    message: '编辑口令已初始化，请直接登录。',
                },
                { status: 409 }
            );
        }

        if (error instanceof RuntimeEditorAuthInvalidSecretError) {
            recordEditorAuthFailure(request, 'setup');
            return NextResponse.json(
                {
                    message: '编辑口令至少需要 12 个字符。',
                },
                { status: 400 }
            );
        }

        console.error('Failed to initialize editor auth:', error);
        return NextResponse.json(
            {
                message: '初始化编辑口令失败，请检查服务器数据目录写入权限。',
            },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    try {
        revokeRuntimeEditorSession();
        recordEditorAuditEvent({
            action: 'auth.logout',
            resource: 'editor-auth',
            outcome: 'success',
        });
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return clearEditorSessionCookie(invalidResponse);
        }

        throw error;
    }

    return clearEditorSessionCookie(NextResponse.json({ success: true }));
}
