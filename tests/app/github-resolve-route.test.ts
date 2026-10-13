import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postResolve } from '@/app/api/editor/github/resolve/route';
import { ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { listInstallationRepositories } from '@/lib/github/discovery';
import { hasGitHubPrivateKey, loadGitHubPrivateKey } from '@/lib/github/secrets';
import { GitHubApiError } from '@/lib/github/client';

vi.mock('@/lib/editor-api-auth', () => ({
    ensureEditorWriteRequest: vi.fn(),
}));
vi.mock('@/lib/github/discovery', () => ({
    listInstallationRepositories: vi.fn(),
}));
vi.mock('@/lib/github/secrets', () => ({
    hasGitHubPrivateKey: vi.fn(),
    loadGitHubPrivateKey: vi.fn(),
}));

const mockEnsureEditorWriteRequest = vi.mocked(ensureEditorWriteRequest);
const mockListRepositories = vi.mocked(listInstallationRepositories);
const mockHasKey = vi.mocked(hasGitHubPrivateKey);
const mockLoadKey = vi.mocked(loadGitHubPrivateKey);

const discoveredRepositories = [
    { id: 1, owner: 'owner', name: 'source', isPrivate: true, defaultBranch: 'main' },
    { id: 2, owner: 'owner', name: 'pages', isPrivate: false, defaultBranch: 'main' },
    { id: 3, owner: 'owner', name: 'backup', isPrivate: true, defaultBranch: 'main' },
];

function request(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/editor/github/resolve', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
    return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureEditorWriteRequest.mockResolvedValue(null);
    mockHasKey.mockResolvedValue(false);
    mockLoadKey.mockResolvedValue('loaded-key');
    mockListRepositories.mockResolvedValue(discoveredRepositories);
});

describe('POST /api/editor/github/resolve', () => {
    it('requires an editor session', async () => {
        const authResponse = NextResponse.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 });
        mockEnsureEditorWriteRequest.mockResolvedValue(authResponse);

        const response = await postResolve(request({ appId: '42', installationId: 7 }));

        expect(response.status).toBe(401);
        expect(mockListRepositories).not.toHaveBeenCalled();
    });

    it('rejects an invalid body', async () => {
        const response = await postResolve(request({ appId: '', installationId: -1 }));
        const body = await payload(response);

        expect(response.status).toBe(400);
        expect(body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
        expect(mockListRepositories).not.toHaveBeenCalled();
    });

    it('asks for the private key when none is provided or saved', async () => {
        const response = await postResolve(request({ appId: '42', installationId: 7 }));
        const body = await payload(response);

        expect(response.status).toBe(400);
        expect(body).toMatchObject({
            error: { code: 'INVALID_REQUEST', message: expect.stringContaining('请先粘贴 GitHub App 私钥') },
        });
    });

    it('falls back to the saved private key when the request omits it', async () => {
        mockHasKey.mockResolvedValue(true);

        const response = await postResolve(request({ appId: '42', installationId: 7 }));

        expect(response.status).toBe(200);
        expect(mockLoadKey).toHaveBeenCalledTimes(1);
        expect(mockListRepositories).toHaveBeenCalledWith({ appId: '42', installationId: 7, privateKeyPem: 'loaded-key' });
        expect(await payload(response)).toEqual({ repositories: discoveredRepositories });
    });

    it('uses the provided private key without touching the stored one', async () => {
        const response = await postResolve(request({ appId: ' 42 ', installationId: 7, privateKeyPem: ' provided-key ' }));

        expect(response.status).toBe(200);
        expect(mockHasKey).not.toHaveBeenCalled();
        expect(mockListRepositories).toHaveBeenCalledWith({ appId: '42', installationId: 7, privateKeyPem: 'provided-key' });
    });

    it('maps a missing installation to 404', async () => {
        mockListRepositories.mockRejectedValue(new GitHubApiError('GitHub App 安装不存在、已卸载或不可访问。', 404, 'not_found', false));

        const response = await postResolve(request({ appId: '42', installationId: 7, privateKeyPem: 'key' }));
        const body = await payload(response);

        expect(response.status).toBe(404);
        expect(body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
    });

    it('keeps the GitHub API failure message on 503', async () => {
        mockListRepositories.mockRejectedValue(new GitHubApiError('无法连接 GitHub API，请检查服务器网络或代理设置。', 0, 'network', true));

        const response = await postResolve(request({ appId: '42', installationId: 7, privateKeyPem: 'key' }));
        const body = await payload(response);

        expect(response.status).toBe(503);
        expect(body).toMatchObject({
            error: { code: 'GITHUB_NOT_READY', message: expect.stringContaining('无法连接 GitHub API'), retryable: true },
        });
    });
});
