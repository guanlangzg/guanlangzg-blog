import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRepositories } from '@/lib/github/config';
import { createPublishingGitHubRuntime } from '@/lib/editor-runtime/github-runtime';

const { fakeFetch } = vi.hoisted(() => ({ fakeFetch: vi.fn<typeof fetch>() }));
vi.mock('@/lib/github/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/client')>();
  return { ...actual, GitHubRestClient: class extends actual.GitHubRestClient {
    constructor(options: ConstructorParameters<typeof actual.GitHubRestClient>[0]) { super({ ...options, fetch: fakeFetch }); }
  } };
});

const repositories: GitHubRepositories = {
  source: { owner: 'owner', name: 'source', id: 1 },
  pages: { owner: 'owner', name: 'pages', id: 2 },
  backup: { owner: 'owner', name: 'backup', id: 3 },
};

vi.mock('@/lib/github/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/config')>()),
  readGitHubConnection: async () => ({ status: 'connected', appId: '1', installationId: 2, repos: repositories }),
}));
vi.mock('@/lib/github/app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/app')>()),
  GitHubAppTokenManager: class { getToken = async () => 'fake-token'; },
}));

afterEach(() => {
  vi.restoreAllMocks();
  fakeFetch.mockReset();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('GitHub publishing runtime contract', () => {
  it('preserves attempt identity and maps the client jobs array', async () => {
    const requests: string[] = [];
    const run = { id: 41, head_sha: 'a'.repeat(40), head_branch: 'release', path: '.github/workflows/pages.yml', run_attempt: 2, status: 'completed', conclusion: 'success' };
    fakeFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/attempts/2')) return jsonResponse({ ...run, id: 99 });
      if (url.pathname.endsWith('/attempts/2/jobs')) return jsonResponse({ total_count: 1, jobs: [{ id: 7, name: 'deploy', status: 'completed', conclusion: 'success', steps: [{ name: 'Deploy', status: 'completed', conclusion: 'success' }] }] });
      throw new Error(`Unexpected request ${url}`);
    });
    const runtime = await createPublishingGitHubRuntime();
    expect(runtime).not.toBeNull();
    const result = await runtime!.getAttemptWithJobs(41, 2);
    expect(result).toMatchObject({ runId: 99, runAttempt: 2, branch: 'release', workflow: '.github/workflows/pages.yml', headSha: 'a'.repeat(40), jobs: [{ name: 'deploy', status: 'completed' }] });
    expect(requests).toHaveLength(2);
  });

  it('reads every run and attempt-jobs page at 100 items', async () => {
    const requests: string[] = [];
    fakeFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/attempts/1')) return jsonResponse({ id: 41, head_sha: 'b'.repeat(40), head_branch: 'main', path: '.github/workflows/deploy.yml', run_attempt: 1, status: 'completed', conclusion: 'success' });
      if (url.pathname.endsWith('/attempts/1/jobs')) {
        const page = Number(url.searchParams.get('page'));
        const count = page === 1 ? 100 : 1;
        return jsonResponse({ total_count: 101, jobs: Array.from({ length: count }, (_, index) => ({ id: (page - 1) * 100 + index + 1, name: `job-${page}-${index}`, status: 'completed', conclusion: 'success', steps: [] })) });
      }
      if (url.pathname.endsWith('/workflows/.github%2Fworkflows%2Fdeploy.yml/runs') || url.pathname.endsWith('/workflows/.github/workflows/deploy.yml/runs') || url.pathname.endsWith('/workflows/deploy.yml/runs')) {
        const page = Number(url.searchParams.get('page'));
        const count = page === 1 ? 100 : 1;
        return jsonResponse({ total_count: 101, workflow_runs: Array.from({ length: count }, (_, index) => ({ id: (page - 1) * 100 + index + 1, head_sha: 'b'.repeat(40), head_branch: 'main', path: '.github/workflows/deploy.yml', run_attempt: 1 })) });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const runtime = await createPublishingGitHubRuntime();
    expect(runtime).not.toBeNull();
    const [runs, attempt] = await Promise.all([
      runtime!.listRunsByHeadSha('b'.repeat(40), '.\\.github\\workflows\\deploy.yml'),
      runtime!.getAttemptWithJobs(41, 1),
    ]);
    expect(runs).toHaveLength(101);
    expect(attempt.jobs).toHaveLength(101);
    expect(requests).toEqual(expect.arrayContaining([
      expect.stringContaining('page=1&per_page=100'),
      expect.stringContaining('page=2&per_page=100'),
    ]));
  });

  it('matches only the normalized exact workflow path', async () => {
    fakeFetch.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/runs')) {
        return jsonResponse({ workflow_runs: [
          { id: 1, head_sha: 'c'.repeat(40), head_branch: 'main', path: 'other/deploy.yml', run_attempt: 1 },
          { id: 2, head_sha: 'c'.repeat(40), head_branch: 'main', path: '.github/workflows/deploy.yml', run_attempt: 1 },
        ] });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const runtime = await createPublishingGitHubRuntime();
    expect(runtime).not.toBeNull();
    const runs = await runtime!.listRunsByHeadSha('c'.repeat(40), 'deploy.yml');
    expect(runs.map((run) => run.workflow)).toEqual(['.github/workflows/deploy.yml']);
  });
});
