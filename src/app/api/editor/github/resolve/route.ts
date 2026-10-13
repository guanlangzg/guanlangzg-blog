import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { listInstallationRepositories } from '@/lib/github/discovery';
import { GitHubApiError } from '@/lib/github/client';
import { hasGitHubPrivateKey, loadGitHubPrivateKey } from '@/lib/github/secrets';

type GitHubResolveBody = {
    appId?: unknown;
    installationId?: unknown;
    privateKeyPem?: unknown;
};

function mapResolveError(error: unknown): NextResponse {
    if (error instanceof GitHubApiError) {
        const status = error.category === 'not_found'
            ? 404
            : error.category === 'rate_limit'
                ? 429
                : 503;
        return createEditorApiError(status === 404 ? 'RESOURCE_NOT_FOUND' : 'GITHUB_NOT_READY', status, {
            message: error.message,
            retryable: error.retryable,
        });
    }

    if (error instanceof Error && /私钥|private key/i.test(error.message)) {
        return createEditorApiError('INVALID_REQUEST', 400, { message: error.message });
    }

    return createEditorApiError('GITHUB_NOT_READY', 503, {
        message: '无法获取 GitHub 仓库列表，请稍后重试。',
        retryable: true,
    });
}

export async function POST(request: NextRequest) {
    try {
        const auth = await ensureEditorWriteRequest(request);
        if (auth) return normalizeEditorApiResponse(auth);

        let body: GitHubResolveBody | null;
        try {
            body = await readJsonBodyWithLimit<GitHubResolveBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
        } catch (error) {
            if (error instanceof JsonBodyTooLargeError) return createJsonBodyTooLargeResponse();
            if (error instanceof JsonBodyParseError) return createJsonBodyParseErrorResponse();
            throw error;
        }

        const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
        const installationId = typeof body?.installationId === 'number' ? body.installationId : Number.NaN;
        const providedKey = typeof body?.privateKeyPem === 'string' ? body.privateKeyPem.trim() : '';

        if (!appId || !Number.isSafeInteger(installationId) || installationId <= 0) {
            return createEditorApiError('INVALID_REQUEST', 400, { message: '请填写有效的 GitHub App ID 和安装 ID。' });
        }

        let privateKeyPem = providedKey;
        if (!privateKeyPem) {
            try {
                if (await hasGitHubPrivateKey()) {
                    privateKeyPem = await loadGitHubPrivateKey();
                }
            } catch (error) {
                return createEditorApiError('INVALID_REQUEST', 400, {
                    message: error instanceof Error ? error.message : 'GitHub App 私钥不可用。',
                });
            }
        }

        if (!privateKeyPem) {
            return createEditorApiError('INVALID_REQUEST', 400, {
                message: '请先粘贴 GitHub App 私钥（PEM）后再获取仓库列表。',
            });
        }

        const repositories = await listInstallationRepositories({ appId, installationId, privateKeyPem });
        return privateJson({ repositories });
    } catch (error) {
        return mapResolveError(error);
    }
}
