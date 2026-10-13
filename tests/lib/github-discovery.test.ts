import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '@/lib/github/client';
import { listInstallationRepositories } from '@/lib/github/discovery';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const VALID_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function createJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn<typeof fetch>();
}

describe('listInstallationRepositories', () => {
    it('creates an installation token and returns parsed repositories sorted by name', async () => {
        const fetchMock = createFetchMock();
        fetchMock
            .mockResolvedValueOnce(createJsonResponse({ token: 'installation-token', expires_at: '2026-01-01T00:00:00Z', permissions: {} }))
            .mockResolvedValueOnce(createJsonResponse({
                total_count: 2,
                repositories: [
                    { id: 2, full_name: 'owner/pages', private: false, default_branch: 'main' },
                    { id: 1, full_name: 'owner/Source', private: true, default_branch: 'trunk' },
                ],
            }));

        const repositories = await listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: VALID_PEM,
            fetch: fetchMock as unknown as typeof fetch,
            now: () => 1_000,
        });

        expect(repositories).toEqual([
            { id: 1, owner: 'owner', name: 'Source', isPrivate: true, defaultBranch: 'trunk' },
            { id: 2, owner: 'owner', name: 'pages', isPrivate: false, defaultBranch: 'main' },
        ]);

        const [tokenCall, listCall] = fetchMock.mock.calls;
        expect(tokenCall[0]).toBe('https://api.github.com/app/installations/7/access_tokens');
        expect((tokenCall[1] as RequestInit).method).toBe('POST');
        expect((tokenCall[1] as RequestInit).body).toBe(JSON.stringify({ permissions: { contents: 'read' } }));
        expect((tokenCall[1] as RequestInit).headers).toMatchObject({ Authorization: expect.stringContaining('Bearer ') });
        expect(listCall[0]).toBe('https://api.github.com/installation/repositories?per_page=100&page=1');
        expect((listCall[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer installation-token' });
    });

    it('paginates until a short page and keeps a single entry per repository id', async () => {
        const fetchMock = createFetchMock();
        fetchMock
            .mockResolvedValueOnce(createJsonResponse({ token: 'installation-token', expires_at: '2026-01-01T00:00:00Z', permissions: {} }))
            .mockResolvedValueOnce(createJsonResponse({
                repositories: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, full_name: `owner/repo-${index}`, private: true })),
            }))
            .mockResolvedValueOnce(createJsonResponse({
                repositories: [
                    { id: 101, full_name: 'owner/aaa-last', private: true },
                    { id: 1, full_name: 'owner/duplicate', private: true },
                ],
            }));

        const repositories = await listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: VALID_PEM,
            fetch: fetchMock as unknown as typeof fetch,
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(repositories.filter((repo) => repo.id === 1)).toHaveLength(1);
        expect(repositories[0]?.name).toBe('aaa-last');
        expect(repositories.at(-1)?.name).toBe('repo-99');
    });

    it('rejects an unusable private key before any network request', async () => {
        const fetchMock = createFetchMock();

        await expect(listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: 'not-a-pem',
            fetch: fetchMock as unknown as typeof fetch,
        })).rejects.toMatchObject({ category: 'http', message: expect.stringContaining('私钥无效') });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps a failed token request to a categorized GitHub API error', async () => {
        const fetchMock = createFetchMock();
        fetchMock.mockResolvedValueOnce(createJsonResponse({ message: 'Not Found' }, 404));

        const error = await listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: VALID_PEM,
            fetch: fetchMock as unknown as typeof fetch,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error).toMatchObject({ status: 404, category: 'not_found' });
    });

    it('wraps transport failures as retryable network errors', async () => {
        const fetchMock = createFetchMock();
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));

        const error = await listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: VALID_PEM,
            fetch: fetchMock as unknown as typeof fetch,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error).toMatchObject({ category: 'network', retryable: true });
    });

    it('rejects a repository list payload without a repositories array', async () => {
        const fetchMock = createFetchMock();
        fetchMock
            .mockResolvedValueOnce(createJsonResponse({ token: 'installation-token', expires_at: '2026-01-01T00:00:00Z', permissions: {} }))
            .mockResolvedValueOnce(createJsonResponse({ total_count: 0 }));

        const error = await listInstallationRepositories({
            appId: '42',
            installationId: 7,
            privateKeyPem: VALID_PEM,
            fetch: fetchMock as unknown as typeof fetch,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error).toMatchObject({ status: 502, category: 'http' });
    });
});
