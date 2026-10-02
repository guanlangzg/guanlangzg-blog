import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    EditorDataRootUnavailableError,
    getEditorDataResourceManifest,
    readNavigationFromDisk,
    writeNavigationToDiskIfRevisionMatches,
} from '@/lib/editor-data-storage';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import { NavigationDataParseError, parseNavigationDataOrThrow } from '@/lib/navigation-data';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';

type NavigationRequestBody = {
    categories?: unknown;
    revision?: unknown;
};

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    const persistent = await hasWritableRuntimeDataRoot();

    try {
        const categories = readNavigationFromDisk();
        const resourceManifest = getEditorDataResourceManifest('navigation', categories);

        return NextResponse.json({
            persistent,
            revision: resourceManifest?.revision ?? null,
            categories,
        });
    } catch (error) {
        if (error instanceof EditorDataRootUnavailableError) {
            return NextResponse.json({
                persistent: false,
                revision: null,
                categories: [],
            });
        }

        const invalidResponse = createEditorDataFileInvalidResponse(error);

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

    let body: NavigationRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<NavigationRequestBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    let parsed;

    try {
        parsed = parseNavigationDataOrThrow(body?.categories);
    } catch (error) {
        if (error instanceof NavigationDataParseError) {
            return NextResponse.json(
                {
                    message: error.message,
                },
                { status: 400 }
            );
        }

        throw error;
    }

    const expectedRevision = typeof body?.revision === 'string' ? body.revision : null;
    let writeResult;

    try {
        writeResult = await writeNavigationToDiskIfRevisionMatches(parsed, expectedRevision);
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const lockTimeoutResponse = createEditorDataLockTimeoutResponse(error);

        if (lockTimeoutResponse) {
            return lockTimeoutResponse;
        }

        const invalidResponse = createEditorDataFileInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }

    if (!writeResult.success) {
        return NextResponse.json(
            {
                message: '导航数据已被其他会话更新，请刷新后重试。',
                revision: writeResult.currentManifest?.revision ?? null,
                categories: writeResult.currentValue,
            },
            { status: 409 }
        );
    }

    const remoteBackup = await queueCurrentBackupToRemote({
        reason: 'navigation-write',
    });
    invalidatePublicContentCache('navigation-write');

    return NextResponse.json({
        success: true,
        revision: writeResult.resourceManifest.revision,
        remoteBackup,
    });
}
