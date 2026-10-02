import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
    EDITOR_CSRF_COOKIE,
    EDITOR_CSRF_HEADER,
    EDITOR_SESSION_COOKIE,
} from '@/lib/editor-auth';
import {
    RuntimeEditorAuthConfigInvalidError,
    isRuntimeEditorAuthConfigured,
    isValidRuntimeEditorSession,
} from '@/lib/editor-auth-runtime';
import {
    EditorBackupFormatError,
    EditorBackupVersionError,
    EditorBackupSchemaVersionError,
} from '@/lib/editor-data-backup';
import {
    EditorDataFileInvalidError,
    EditorDataLockTimeoutError,
    EditorDataRootUnavailableError,
} from '@/lib/editor-data-storage';
import { getPublicRequestOrigin } from '@/lib/request-origin';

export const EDITOR_AUTH_CONFIG_INVALID_MESSAGE = '编辑口令配置文件损坏，请修复或删除后重试。';
const EDITOR_DATA_ROOT_UNAVAILABLE_ERROR_CODES = new Set([
    'EACCES',
    'ENOENT',
    'ENOTDIR',
    'EPERM',
    'EROFS',
]);

function createEditorCsrfInvalidResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '编辑请求校验失败，请刷新页面后重试。',
        },
        { status: 403 }
    );
}

function isSameOriginEditorRequest(request: NextRequest): boolean {
    const origin = request.headers.get('origin');

    if (!origin) {
        return false;
    }

    return origin === getPublicRequestOrigin(request);
}

function isValidEditorCsrfToken(request: NextRequest): boolean {
    const csrfCookie = request.cookies.get(EDITOR_CSRF_COOKIE)?.value;
    const csrfHeader = request.headers.get(EDITOR_CSRF_HEADER);

    if (!(csrfCookie && csrfHeader)) {
        return false;
    }

    const a = Buffer.from(csrfCookie);
    const b = Buffer.from(csrfHeader);

    return a.length === b.length && timingSafeEqual(a, b);
}

export async function ensureEditorSession(request: NextRequest): Promise<NextResponse | null> {
    try {
        if (!isRuntimeEditorAuthConfigured()) {
            return NextResponse.json(
                {
                    message: '未初始化编辑口令，编辑区已被锁定。',
                },
                { status: 503 }
            );
        }

        const session = request.cookies.get(EDITOR_SESSION_COOKIE)?.value;

        if (!(await isValidRuntimeEditorSession(session))) {
            return NextResponse.json(
                {
                    message: '未授权访问编辑数据。',
                },
                { status: 401 }
            );
        }
    } catch (error) {
        const invalidResponse = createEditorAuthConfigInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }

    return null;
}

export async function ensureEditorWriteRequest(request: NextRequest): Promise<NextResponse | null> {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    if (!isSameOriginEditorRequest(request) || !isValidEditorCsrfToken(request)) {
        return createEditorCsrfInvalidResponse();
    }

    return null;
}

export function createEditorDataFileInvalidResponse(error: unknown): NextResponse | null {
    if (!(error instanceof EditorDataFileInvalidError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: '服务器运行时数据文件损坏，请修复数据文件后重试。',
            resource: error.resource,
        },
        { status: 500 }
    );
}

export function createEditorDataLockTimeoutResponse(error: unknown): NextResponse | null {
    if (!(error instanceof EditorDataLockTimeoutError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: '服务器运行时数据正在写入，请稍后重试。',
        },
        { status: 423 }
    );
}

export function createEditorDataRootUnavailableResponse(error: unknown): NextResponse | null {
    if (!(error instanceof EditorDataRootUnavailableError)) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;

        if (!code || !EDITOR_DATA_ROOT_UNAVAILABLE_ERROR_CODES.has(code)) {
            return null;
        }
    }

    return NextResponse.json(
        {
            code: 'runtime_data_root_unavailable',
            message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
        },
        { status: 503 }
    );
}

export function createEditorBackupInvalidResponse(error: unknown): NextResponse | null {
    if (
        !(error instanceof EditorBackupFormatError) &&
        !(error instanceof EditorBackupVersionError) &&
        !(error instanceof EditorBackupSchemaVersionError)
    ) {
        return null;
    }

    return NextResponse.json(
        {
            message: error.message,
        },
        { status: 400 }
    );
}

export function createEditorAuthConfigInvalidResponse(error: unknown): NextResponse | null {
    if (!(error instanceof RuntimeEditorAuthConfigInvalidError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: EDITOR_AUTH_CONFIG_INVALID_MESSAGE,
        },
        { status: 500 }
    );
}
