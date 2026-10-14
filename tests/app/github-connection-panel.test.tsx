import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubConnectionPanel } from '@/app/editor/(authenticated)/publishing/GitHubConnectionPanel';

type ConnectionDto = {
    privateKeyConfigured: boolean;
    appId: string | null;
    installationId: number | null;
    repos: { source: { owner: string; name: string; id: number }; pages: { owner: string; name: string; id: number }; backup: { owner: string; name: string; id: number } } | null;
    status: string;
};

const notConfiguredDto: ConnectionDto = {
    privateKeyConfigured: false,
    appId: null,
    installationId: null,
    repos: null,
    status: 'not_configured',
};

const pendingDto: ConnectionDto = {
    privateKeyConfigured: true,
    appId: '42',
    installationId: 7,
    repos: {
        source: { owner: 'owner', name: 'source', id: 1 },
        pages: { owner: 'owner', name: 'pages', id: 2 },
        backup: { owner: 'owner', name: 'backup', id: 3 },
    },
    status: 'pending',
};

const connectedDto: ConnectionDto = { ...pendingDto, status: 'connected' };

const discoveredRepositories = [
    { id: 1, owner: 'owner', name: 'source', isPrivate: true, defaultBranch: 'main' },
    { id: 2, owner: 'owner', name: 'pages', isPrivate: false, defaultBranch: 'main' },
    { id: 3, owner: 'owner', name: 'backup', isPrivate: true, defaultBranch: 'main' },
];

function createJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// One macrotask tick drains every pending fetch-chain microtask before React
// flushes inside act, so assertions can rely on state being settled.
async function flushAll(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
    });
}

describe('GitHubConnectionPanel', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    // Simulates the server-side connection record: GET returns the current value
    // and save/check side effects transition it, mirroring the real runtime.
    let currentConnection: ConnectionDto;
    let jobOutcome: ConnectionDto;

    beforeEach(() => {
        // Only the poll sleep is faked; React scheduling timers must stay real.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        currentConnection = notConfiguredDto;
        jobOutcome = connectedDto;
        fetchMock = vi.fn();
        fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/api/editor/github') && method === 'GET') {
                return Promise.resolve(createJsonResponse(currentConnection));
            }
            if (url.endsWith('/api/editor/github/resolve')) {
                return Promise.resolve(createJsonResponse({ repositories: discoveredRepositories }));
            }
            if (url.endsWith('/api/editor/github') && method === 'PUT') {
                currentConnection = pendingDto;
                return Promise.resolve(createJsonResponse(pendingDto));
            }
            if (url.endsWith('/api/editor/github/check')) {
                return Promise.resolve(createJsonResponse({ jobId: 'job-check', status: 'pending' }, 202));
            }
            if (url.endsWith('/api/editor/jobs/job-check')) {
                currentConnection = jobOutcome;
                return Promise.resolve(createJsonResponse({ id: 'job-check', status: 'succeeded' }));
            }
            throw new Error(`Unexpected fetch: ${method} ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function expandPanel(): Promise<void> {
        fireEvent.click(screen.getByRole('button', { name: '展开配置' }));
        await flushAll();
    }

    async function discoverAndAssignRoles(): Promise<void> {
        fireEvent.change(screen.getByLabelText('App ID'), { target: { value: '42' } });
        fireEvent.change(screen.getByLabelText('Installation ID'), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: '获取可选仓库' }));
        await flushAll();
        screen.getByText('owner/source');
        fireEvent.click(screen.getByLabelText('将 owner/source 用作源码仓库'));
        fireEvent.click(screen.getByLabelText('将 owner/pages 用作Pages 仓库'));
        fireEvent.click(screen.getByLabelText('将 owner/backup 用作备份仓库'));
    }

    it('loads the connection status on mount and shows a summary while collapsed', async () => {
        currentConnection = connectedDto;
        render(<GitHubConnectionPanel />);
        await flushAll();

        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/editor/github'))).toBe(true);
        expect(screen.getByText('已连接')).toBeInTheDocument();
        // Collapsed view keeps the form lazy: no inputs are rendered yet.
        expect(screen.queryByLabelText('App ID')).not.toBeInTheDocument();
        expect(screen.getByText(/发布工作台与 GitHub 备份现已可用/)).toBeInTheDocument();

        await expandPanel();

        expect((screen.getByLabelText('App ID') as HTMLInputElement).value).toBe('42');
        expect((screen.getByLabelText('Installation ID') as HTMLInputElement).value).toBe('7');
    });

    it('discovers installation repositories and assigns the three roles', async () => {
        render(<GitHubConnectionPanel />);
        await expandPanel();
        await discoverAndAssignRoles();

        const resolveCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/editor/github/resolve'));
        expect(resolveCall).toBeDefined();
        expect(JSON.parse(resolveCall?.[1]?.body as string)).toEqual({ appId: '42', installationId: 7 });
        expect((screen.getByLabelText('将 owner/source 用作源码仓库') as HTMLInputElement).checked).toBe(true);
    });

    it('offers to expand configuration when not connected', async () => {
        render(<GitHubConnectionPanel />);
        await flushAll();

        // not_configured: the status cell and the collapsed guidance both
        // mention it, and the form stays behind the expand button.
        expect(screen.getAllByText('未配置').length).toBeGreaterThan(0);
        expect(screen.getByText(/填写 App 信息并保存后/)).toBeInTheDocument();
        expect(screen.queryByLabelText('App ID')).not.toBeInTheDocument();
    });

    it('saves the configuration, runs verification, and reports success', async () => {
        render(<GitHubConnectionPanel />);
        await expandPanel();
        fireEvent.change(screen.getByLabelText('App 私钥（PEM）'), { target: { value: 'private-key-pem' } });
        await discoverAndAssignRoles();

        fireEvent.click(screen.getByRole('button', { name: '保存并验证' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_100);
        });
        await flushAll();

        expect(screen.getByText('GitHub 连接验证通过，发布工作台与 GitHub 备份现已可用。')).toBeInTheDocument();

        const putCall = fetchMock.mock.calls.find(([, init]) => (init?.method ?? '').toUpperCase() === 'PUT');
        expect(putCall).toBeDefined();
        expect(JSON.parse(putCall?.[1]?.body as string)).toEqual({
            appId: '42',
            installationId: 7,
            repos: {
                source: { owner: 'owner', name: 'source', id: 1 },
                pages: { owner: 'owner', name: 'pages', id: 2 },
                backup: { owner: 'owner', name: 'backup', id: 3 },
            },
            privateKeyPem: 'private-key-pem',
        });
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/editor/github/check'))).toBe(true);
    });

    it('reports a failed verification with recovery guidance', async () => {
        render(<GitHubConnectionPanel />);
        await expandPanel();
        await discoverAndAssignRoles();
        jobOutcome = { ...pendingDto, status: 'permission_error' };

        fireEvent.click(screen.getByRole('button', { name: '保存并验证' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_100);
        });
        await flushAll();

        expect(screen.getByText(/验证未通过（权限不足）/)).toBeInTheDocument();
    });

    it('keeps manual repository entry usable when discovery is unavailable', async () => {
        render(<GitHubConnectionPanel />);
        await expandPanel();

        fireEvent.change(screen.getByLabelText('App ID'), { target: { value: '42' } });
        fireEvent.change(screen.getByLabelText('Installation ID'), { target: { value: '7' } });
        fireEvent.click(screen.getByLabelText('手动填写仓库（无法自动获取时）'));
        fireEvent.change(screen.getByLabelText('源码仓库 owner'), { target: { value: 'owner' } });
        fireEvent.change(screen.getByLabelText('源码仓库 name'), { target: { value: 'source' } });
        fireEvent.change(screen.getByLabelText('源码仓库 数字 ID'), { target: { value: '1' } });
        fireEvent.change(screen.getByLabelText('Pages 仓库 owner'), { target: { value: 'owner' } });
        fireEvent.change(screen.getByLabelText('Pages 仓库 name'), { target: { value: 'pages' } });
        fireEvent.change(screen.getByLabelText('Pages 仓库 数字 ID'), { target: { value: '2' } });
        fireEvent.change(screen.getByLabelText('备份仓库 owner'), { target: { value: 'owner' } });
        fireEvent.change(screen.getByLabelText('备份仓库 name'), { target: { value: 'backup' } });
        fireEvent.change(screen.getByLabelText('备份仓库 数字 ID'), { target: { value: '3' } });

        fireEvent.click(screen.getByRole('button', { name: '保存并验证' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_100);
        });
        await flushAll();

        expect(screen.getByText(/GitHub 连接验证通过/)).toBeInTheDocument();
        const putCall = fetchMock.mock.calls.find(([, init]) => (init?.method ?? '').toUpperCase() === 'PUT');
        expect(JSON.parse(putCall?.[1]?.body as string)).toMatchObject({
            repos: {
                source: { owner: 'owner', name: 'source', id: 1 },
                pages: { owner: 'owner', name: 'pages', id: 2 },
                backup: { owner: 'owner', name: 'backup', id: 3 },
            },
        });
    });
});
