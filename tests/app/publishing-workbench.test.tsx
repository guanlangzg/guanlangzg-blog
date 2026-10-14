import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublishingPage from '@/app/editor/(authenticated)/publishing/page';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

type ResponseLike = { ok: boolean; status?: number; json: () => Promise<unknown> };

function jsonResponse(body: unknown, status = 200): ResponseLike {
  return { ok: status < 400, status, json: async () => body };
}

// The publishing page mounts the GitHub connection panel, which adds a
// /api/editor/github status fetch alongside the release/revision polls. Mock
// by method+URL so call order never matters.
interface RouteState {
  releases?: unknown[][];
  revisions?: Record<string, string>;
  github?: unknown;
  jobs?: Record<string, unknown>;
  postResponses?: Record<string, () => ResponseLike>;
}

function mockPublishingRoutes(state: RouteState = {}) {
  const releaseBatches = [...(state.releases ?? [[]])];

  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'POST' && state.postResponses?.[url]) {
      return Promise.resolve(state.postResponses[url]());
    }

    if (url === '/api/editor/publishing-revision') {
      return Promise.resolve(jsonResponse({ revisions: state.revisions ?? {} }));
    }

    if (url === '/api/editor/github') {
      return Promise.resolve(jsonResponse(state.github ?? { status: 'not_configured' }));
    }

    if (url === '/api/editor/releases') {
      const batch = releaseBatches.shift() ?? releaseBatches.at(-1) ?? [];
      return Promise.resolve(jsonResponse({ releases: batch }));
    }

    if (url.startsWith('/api/editor/jobs/')) {
      return Promise.resolve(jsonResponse(state.jobs?.[url] ?? {}));
    }

    return Promise.resolve(jsonResponse({}));
  });
}

describe('publishing workbench', () => {
  it('shows the GitHub connection panel above the candidate form', async () => {
    mockPublishingRoutes({ github: { status: 'connected', appId: '42', installationId: 7, privateKeyConfigured: true, repos: null } });

    render(<PublishingPage />);
    expect(await screen.findByText('已连接')).toBeInTheDocument();
    expect(screen.getByText('GitHub 连接')).toBeInTheDocument();
    // The candidate panel must sit below the connection gate in DOM order.
    const connectionPanel = screen.getByText('GitHub 连接').closest('section');
    const candidateHeading = screen.getByText('创建发布候选');
    if (!connectionPanel) throw new Error('GitHub connection panel section not rendered');
    expect(connectionPanel.compareDocumentPosition(candidateHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('creates a candidate using the selected scope and shows the release state', async () => {
    const release = { id: 'rel-1', scope: { kind: 'navigation' }, status: 'building', candidateDigest: 'a'.repeat(64), artifactDigest: null, hasBackupProof: false, error: null };
    mockPublishingRoutes({
      releases: [[], [release]],
      revisions: { article: 'revision-1', navigation: 'navigation-revision' },
      postResponses: { '/api/editor/releases': () => jsonResponse({ releaseId: 'rel-1', status: 'building' }) },
    });

    render(<PublishingPage />);
    await screen.findByText('发布记录');
    fireEvent.change(screen.getByLabelText('发布范围'), { target: { value: 'navigation' } });
    fireEvent.click(screen.getByRole('button', { name: '创建候选' }));

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/editor/releases' && call[1]?.method === 'POST')).toBe(true));
    const createRequest = fetchMock.mock.calls.find((call) => call[0] === '/api/editor/releases' && call[1]?.method === 'POST');
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest?.[1].body)).toMatchObject({ scope: { kind: 'navigation' }, expectedRevision: 'navigation-revision' });
    expect(await screen.findByText('候选 rel-1 已创建。')).toBeInTheDocument();
  });

  it('sends both server-provided digests when confirming a ready candidate', async () => {
    const ready = { id: 'rel-1', scope: { kind: 'settings' }, status: 'preview_ready', candidateDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), hasBackupProof: true, error: null };
    mockPublishingRoutes({
      releases: [[ready]],
      revisions: {},
      postResponses: { '/api/editor/releases/rel-1/confirmation': () => jsonResponse({ taskId: 'job-1' }) },
    });

    render(<PublishingPage />);
    const button = await screen.findByRole('button', { name: '确认发布' });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/editor/releases/rel-1/confirmation')).toBe(true));
    const confirmation = fetchMock.mock.calls.find((call) => call[0] === '/api/editor/releases/rel-1/confirmation');
    expect(confirmation).toBeDefined();
    expect(JSON.parse(confirmation?.[1].body)).toEqual({ candidateDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64) });
  });

  it('shows the nested server error message when creating a candidate fails', async () => {
    mockPublishingRoutes({
      revisions: { navigation: 'revision-1' },
      postResponses: {
        '/api/editor/releases': () => jsonResponse({
          error: {
            code: 'REVISION_CONFLICT',
            message: '数据已变化，请刷新后重试。',
            retryable: false,
            requestId: 'req-conflict',
          },
        }, 409),
      },
    });

    render(<PublishingPage />);
    await screen.findByText('发布记录');
    fireEvent.change(screen.getByLabelText('发布范围'), { target: { value: 'navigation' } });
    fireEvent.click(screen.getByRole('button', { name: '创建候选' }));

    expect(await screen.findByText('数据已变化，请刷新后重试。')).toBeInTheDocument();
  });

  it('shows the nested job error message for a failed publish task', async () => {
    const release = {
      id: 'rel-job',
      scope: { kind: 'navigation' },
      status: 'publishing',
      candidateDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      hasBackupProof: true,
      publicCommitSha: null,
      workflowRunId: 1,
      workflowRunAttempt: 1,
      error: null,
      taskId: 'job-1',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    };
    mockPublishingRoutes({
      releases: [[release]],
      revisions: {},
      jobs: {
        '/api/editor/jobs/job-1': {
          id: 'job-1',
          type: 'publish',
          status: 'failed',
          attempt: 2,
          nextAttemptAt: null,
          remoteCommit: null,
          error: { message: '构建步骤失败：依赖安装超时。' },
        },
      },
    });

    render(<PublishingPage />);

    expect(await screen.findByText(/构建步骤失败：依赖安装超时。/)).toBeInTheDocument();
  });

  it('keeps the newest release list when an older poll response resolves later', async () => {
    // Only the polling interval is faked; React's own scheduling timers must
    // keep running so act() can flush the state transitions.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    type DeferredResponse = { ok: boolean; json: () => Promise<unknown> };
    const releaseResponses: Array<{ promise: Promise<DeferredResponse>; resolve: (value: DeferredResponse) => void }> = [];

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/editor/publishing-revision') {
        return Promise.resolve({ ok: true, json: async () => ({ revisions: {} }) });
      }

      if (url === '/api/editor/github') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'not_configured' }) });
      }

      if (url === '/api/editor/releases') {
        let resolveDeferred: (value: DeferredResponse) => void = () => undefined;
        const promise = new Promise<DeferredResponse>((resolve) => { resolveDeferred = resolve; });

        releaseResponses.push({ promise, resolve: resolveDeferred });

        return promise;
      }

      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const buildRelease = (id: string) => ({
      id,
      scope: { kind: 'navigation' },
      status: 'building',
      candidateDigest: 'a'.repeat(64),
      artifactDigest: null,
      hasBackupProof: false,
      publicCommitSha: null,
      workflowRunId: null,
      workflowRunAttempt: null,
      error: null,
      taskId: null,
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    });

    render(<PublishingPage />);
    await act(async () => { releaseResponses[0]?.resolve({ ok: true, json: async () => ({ releases: [buildRelease('rel-old')] }) }); });
    expect(screen.getByText('rel-old')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => { vi.advanceTimersByTime(5000); });

    expect(releaseResponses).toHaveLength(3);

    await act(async () => { releaseResponses[2]?.resolve({ ok: true, json: async () => ({ releases: [buildRelease('rel-new')] }) }); });
    expect(screen.getByText('rel-new')).toBeInTheDocument();

    await act(async () => { releaseResponses[1]?.resolve({ ok: true, json: async () => ({ releases: [buildRelease('rel-old')] }) }); });

    expect(screen.getByText('rel-new')).toBeInTheDocument();
    expect(screen.queryByText('rel-old')).not.toBeInTheDocument();
  });

  it('does not offer confirmation without a sealed artifact digest', async () => {
    mockPublishingRoutes({
      releases: [[{ id: 'rel-1', scope: { kind: 'settings' }, status: 'building', candidateDigest: 'a'.repeat(64), artifactDigest: null, hasBackupProof: false, error: null }]],
      revisions: { article: 'revision-1' },
    });
    render(<PublishingPage />);
    await waitFor(() => expect(screen.getByText('发布记录')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '确认发布' })).not.toBeInTheDocument();
  });
});
