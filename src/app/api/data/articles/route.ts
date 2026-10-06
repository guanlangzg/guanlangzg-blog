import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import { ArticleDataParseError, parseArticleDataOrThrow, parseArticlesDataOrThrow } from '@/lib/article-data';
import {
    createEditorBackupStateInvalidResponse,
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    EditorDataRootUnavailableError,
    getEditorDataResourceManifest,
    readArticlesFromDisk,
    patchArticlesToDiskIfRevisionMatches,
    writeArticlesToDiskIfRevisionMatches,
} from '@/lib/editor-data-storage';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';

type ArticlesRequestBody = {
    articles?: unknown;
    revision?: unknown;
};

type ArticlesPatchBody = {
    operation?: unknown;
    article?: unknown;
    id?: unknown;
    revision?: unknown;
};

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    const persistent = await hasWritableRuntimeDataRoot();

    try {
        const articles = readArticlesFromDisk();
        const resourceManifest = getEditorDataResourceManifest('articles', articles);

        return NextResponse.json({
            persistent,
            revision: resourceManifest?.revision ?? null,
            articles,
        });
    } catch (error) {
        if (error instanceof EditorDataRootUnavailableError) {
            return NextResponse.json({
                persistent: false,
                revision: null,
                articles: [],
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

    let body: ArticlesRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<ArticlesRequestBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    let articles;

    try {
        articles = parseArticlesDataOrThrow(body?.articles);
    } catch (error) {
        if (error instanceof ArticleDataParseError) {
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
        writeResult = await writeArticlesToDiskIfRevisionMatches(articles, expectedRevision);
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const backupStateResponse = createEditorBackupStateInvalidResponse(error);

        if (backupStateResponse) {
            return backupStateResponse;
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
                message: '文章数据已被其他会话更新，请刷新后重试。',
                revision: writeResult.currentManifest?.revision ?? null,
                articles: writeResult.currentValue,
            },
            { status: 409 }
        );
    }

    const remoteBackup = await queueCurrentBackupToRemote({
        reason: 'articles-write',
    });
    invalidatePublicContentCache('articles-write');

    return NextResponse.json({
        success: true,
        revision: writeResult.resourceManifest.revision,
        remoteBackup,
    });
}

export async function PATCH(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    let body: ArticlesPatchBody | null;

    try {
        body = await readJsonBodyWithLimit<ArticlesPatchBody>(request, EDITOR_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    const operation = body?.operation;
    const revision = typeof body?.revision === 'string' ? body.revision : null;
    let operations;

    try {
        if (operation === 'delete' && typeof body?.id === 'string' && body.id.trim()) {
            operations = [{ type: 'delete' as const, id: body.id }];
        } else if (operation === 'upsert') {
            operations = [{ type: 'upsert' as const, article: parseArticleDataOrThrow(body?.article) }];
        } else {
            return NextResponse.json({ message: '文章增量操作格式无效。' }, { status: 400 });
        }
    } catch (error) {
        if (error instanceof ArticleDataParseError) {
            return NextResponse.json({ message: error.message }, { status: 400 });
        }

        throw error;
    }

    let writeResult;

    try {
        writeResult = await patchArticlesToDiskIfRevisionMatches(operations, revision);
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);
        if (unavailableResponse) return unavailableResponse;
        const backupStateResponse = createEditorBackupStateInvalidResponse(error);
        if (backupStateResponse) return backupStateResponse;
        const lockTimeoutResponse = createEditorDataLockTimeoutResponse(error);
        if (lockTimeoutResponse) return lockTimeoutResponse;
        const invalidResponse = createEditorDataFileInvalidResponse(error);
        if (invalidResponse) return invalidResponse;

        if (error instanceof ArticleDataParseError) {
            return NextResponse.json({ message: error.message }, { status: 400 });
        }

        throw error;
    }

    if (!writeResult.success) {
        return NextResponse.json(
            {
                message: '文章数据已被其他会话更新，请刷新后重试。',
                revision: writeResult.currentManifest?.revision ?? null,
                articles: writeResult.currentValue,
            },
            { status: 409 }
        );
    }

    const remoteBackup = await queueCurrentBackupToRemote({ reason: 'articles-patch' });
    invalidatePublicContentCache('articles-patch');

    return NextResponse.json({
        success: true,
        revision: writeResult.resourceManifest.revision,
        remoteBackup,
    });
}
