import type { GitHubRepositories, GitHubRepositoryReference } from '@/lib/github/config';
import type { GitHubTokenOperation, GitHubTokenProvider } from '@/lib/github/app';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 1;

export type GitHubApiErrorCategory = 'unauthorized' | 'permission' | 'rate_limit' | 'not_found' | 'conflict' | 'http' | 'network' | 'timeout';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly category: GitHubApiErrorCategory,
    public readonly retryable: boolean,
    public readonly requestId: string | null = null
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubRepositoryInfo extends GitHubRepositoryReference {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubPagesInfo {
  url: string;
  htmlUrl: string;
  source: { branch: string; path: string } | null;
  status: string | null;
}

export interface GitHubWorkflowRun {
  id: number;
  headBranch: string;
  workflowPath: string;
  headSha: string;
  runNumber: number;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  jobsUrl: string;
}

export interface GitHubWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null }>;
}

export interface GitHubRunAttemptWithJobs {
  run: GitHubWorkflowRun;
  jobs: GitHubWorkflowJob[];
}

export interface GitHubRestClientOptions {
  repositories: GitHubRepositories;
  tokenProvider: GitHubTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  operation?: GitHubTokenOperation;
}

interface GitHubErrorPayload {
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function getRetryDelay(response: Response, now: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 60_000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, 60_000));
  }

  const reset = Number(response.headers.get('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.min(reset * 1000 - now, 60_000));
  return 1_000;
}

function isRateLimited(response: Response, payload: GitHubErrorPayload | null): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get('X-RateLimit-Remaining') === '0' ||
    Boolean(response.headers.get('Retry-After')) ||
    /rate limit/i.test(payload?.message ?? '');
}

function mapApiError(response: Response, payload: GitHubErrorPayload | null, rateLimited: boolean): GitHubApiError {
  if (rateLimited) {
    return new GitHubApiError('GitHub API 触发速率限制。', response.status, 'rate_limit', true, response.headers.get('X-GitHub-Request-Id'));
  }
  if (response.status === 401) {
    return new GitHubApiError('GitHub 凭据无效或已过期。', response.status, 'unauthorized', true, response.headers.get('X-GitHub-Request-Id'));
  }
  if (response.status === 403) {
    return new GitHubApiError('GitHub 安装缺少此操作所需的仓库权限。', response.status, 'permission', false, response.headers.get('X-GitHub-Request-Id'));
  }
  if (response.status === 404) {
    return new GitHubApiError('GitHub 仓库或资源不存在，或安装不可访问。', response.status, 'not_found', false, response.headers.get('X-GitHub-Request-Id'));
  }
  if (response.status === 409 || response.status === 422) {
    return new GitHubApiError('GitHub 拒绝了此 Git 数据变更。', response.status, 'conflict', false, response.headers.get('X-GitHub-Request-Id'));
  }
  const detail = payload?.message ? `：${payload.message.replace(/[\r\n]+/g, ' ').slice(0, 160)}` : '';
  return new GitHubApiError(`GitHub API 请求失败（HTTP ${response.status}）${detail}`, response.status, 'http', response.status >= 500, response.headers.get('X-GitHub-Request-Id'));
}

function parseRepository(value: unknown, expected: GitHubRepositoryReference): GitHubRepositoryInfo {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.full_name !== 'string' || typeof value.private !== 'boolean') {
    throw new GitHubApiError('GitHub 仓库信息响应格式无效。', 502, 'http', false);
  }
  const [owner = '', name = ''] = value.full_name.split('/', 2);
  if (
    value.id !== expected.id || owner.toLowerCase() !== expected.owner.toLowerCase() ||
    name.toLowerCase() !== expected.name.toLowerCase()
  ) {
    throw new GitHubApiError('GitHub 返回的仓库与配置的仓库不匹配。', 502, 'http', false);
  }
  return {
    id: value.id,
    owner,
    name,
    fullName: value.full_name,
    private: value.private,
    defaultBranch: typeof value.default_branch === 'string' ? value.default_branch : 'main',
  };
}

function parseWorkflowRun(value: unknown): GitHubWorkflowRun {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.head_sha !== 'string') {
    throw new GitHubApiError('GitHub Actions run 响应格式无效。', 502, 'http', false);
  }
  return {
    id: value.id,
    headBranch: typeof value.head_branch === 'string' ? value.head_branch : '',
    workflowPath: typeof value.path === 'string' ? value.path : '',
    headSha: value.head_sha,
    runNumber: typeof value.run_number === 'number' ? value.run_number : 0,
    runAttempt: typeof value.run_attempt === 'number' ? value.run_attempt : 1,
    status: typeof value.status === 'string' ? value.status : 'unknown',
    conclusion: typeof value.conclusion === 'string' ? value.conclusion : null,
    htmlUrl: typeof value.html_url === 'string' ? value.html_url : '',
    jobsUrl: typeof value.jobs_url === 'string' ? value.jobs_url : '',
  };
}

export class GitHubRestClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: GitHubRestClientOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async getRepository(role: keyof GitHubRepositories): Promise<GitHubRepositoryInfo> {
    const expected = this.options.repositories[role];
    const value = await this.request<unknown>(role === 'backup' ? 'backup' : 'publish', this.repositoryPath(role));
    return parseRepository(value, expected);
  }

  async getGitHubPages(): Promise<GitHubPagesInfo> {
    const role = 'pages';
    const value = await this.request<unknown>('publish', `${this.repositoryPath(role)}/pages`);
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.html_url !== 'string') {
      throw new GitHubApiError('GitHub Pages 响应格式无效。', 502, 'http', false);
    }
    const source = isRecord(value.source) && typeof value.source.branch === 'string'
      ? { branch: value.source.branch, path: typeof value.source.path === 'string' ? value.source.path : '/' }
      : null;
    return {
      url: value.url,
      htmlUrl: value.html_url,
      source,
      status: typeof value.status === 'string' ? value.status : null,
    };
  }

  async getBlob(role: keyof GitHubRepositories, sha: string): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/blobs/${escapePathSegment(sha)}`);
  }

  async createBlob(role: keyof GitHubRepositories, content: string, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/blobs`, {
      method: 'POST', body: { content, encoding },
    });
  }

  async getTree(role: keyof GitHubRepositories, sha: string, recursive = false): Promise<unknown> {
    const suffix = recursive ? '?recursive=1' : '';
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/trees/${escapePathSegment(sha)}${suffix}`);
  }

  async createTree(role: keyof GitHubRepositories, tree: unknown[], baseTree?: string): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/trees`, {
      method: 'POST', body: { tree, ...(baseTree ? { base_tree: baseTree } : {}) },
    });
  }

  async listCommits(role: keyof GitHubRepositories, options: { page?: number; perPage?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams({ page: String(options.page ?? 1), per_page: String(options.perPage ?? 100) });
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/commits?${query}`);
  }

  async getCommit(role: keyof GitHubRepositories, sha: string): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/commits/${escapePathSegment(sha)}`);
  }

  async createCommit(role: keyof GitHubRepositories, input: { message: string; tree: string; parents: string[] }): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/commits`, {
      method: 'POST', body: input,
    });
  }

  async getReference(role: keyof GitHubRepositories, branch: string): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/ref/heads/${escapePathSegment(branch)}`);
  }

  async updateReference(role: keyof GitHubRepositories, branch: string, sha: string): Promise<unknown> {
    return this.request(role === 'backup' ? 'backup' : 'publish', `${this.repositoryPath(role)}/git/refs/heads/${escapePathSegment(branch)}`, {
      method: 'PATCH', body: { sha, force: false },
    });
  }

  async listWorkflowRunsByHeadSha(headSha: string, options: { workflow?: string; page?: number; perPage?: number } = {}): Promise<GitHubWorkflowRun[]> {
    const workflow = options.workflow ?? 'deploy.yml';
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 100;
    const query = new URLSearchParams({ head_sha: headSha, page: String(page), per_page: String(perPage) });
    const value = await this.request<unknown>('publish', `${this.repositoryPath('pages')}/actions/workflows/${escapePathSegment(workflow)}/runs?${query}`);
    if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
      throw new GitHubApiError('GitHub workflow runs 响应格式无效。', 502, 'http', false);
    }
    return value.workflow_runs.map(parseWorkflowRun);
  }

  async getRunAttempt(runId: number, attempt: number): Promise<GitHubWorkflowRun> {
    const value = await this.request<unknown>('publish', `${this.repositoryPath('pages')}/actions/runs/${runId}/attempts/${attempt}`);
    return parseWorkflowRun(value);
  }

  async getRunAttemptJobs(runId: number, attempt: number, options: { page?: number; perPage?: number } = {}): Promise<GitHubWorkflowJob[]> {
    const query = new URLSearchParams({ page: String(options.page ?? 1), per_page: String(options.perPage ?? 100) });
    const value = await this.request<unknown>('publish', `${this.repositoryPath('pages')}/actions/runs/${runId}/attempts/${attempt}/jobs?${query}`);
    if (!isRecord(value) || !Array.isArray(value.jobs)) {
      throw new GitHubApiError('GitHub workflow jobs 响应格式无效。', 502, 'http', false);
    }
    return value.jobs.map((job: unknown) => {
      if (!isRecord(job) || typeof job.id !== 'number' || typeof job.name !== 'string') {
        throw new GitHubApiError('GitHub workflow job 响应格式无效。', 502, 'http', false);
      }
      const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord).map((step) => ({
        name: typeof step.name === 'string' ? step.name : '',
        status: typeof step.status === 'string' ? step.status : 'unknown',
        conclusion: typeof step.conclusion === 'string' ? step.conclusion : null,
      })) : [];
      return {
        id: job.id,
        name: job.name,
        status: typeof job.status === 'string' ? job.status : 'unknown',
        conclusion: typeof job.conclusion === 'string' ? job.conclusion : null,
        steps,
      };
    });
  }

  async getRunAttemptWithJobs(runId: number, attempt: number): Promise<GitHubRunAttemptWithJobs> {
    const [run, jobs] = await Promise.all([
      this.getRunAttempt(runId, attempt),
      this.getRunAttemptJobs(runId, attempt),
    ]);
    return { run, jobs };
  }

  async rerunWorkflowRun(runId: number): Promise<void> {
    await this.request<unknown>('rerun', `${this.repositoryPath('pages')}/actions/runs/${runId}/rerun`, { method: 'POST' });
  }

  private repositoryPath(role: keyof GitHubRepositories): string {
    const repository = this.options.repositories[role];
    return `/repos/${escapePathSegment(repository.owner)}/${escapePathSegment(repository.name)}`;
  }

  private async request<T>(operation: GitHubTokenOperation, endpoint: string, options: RequestOptions = {}): Promise<T> {
    const tokenOperation = endpoint.includes('/actions/runs/') && endpoint.endsWith('/rerun')
      ? 'rerun'
      : options.operation ?? operation;
    let token = await this.options.tokenProvider.getToken(tokenOperation);
    let refreshedUnauthorized = false;
    let rateLimitRetries = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${GITHUB_API_BASE_URL}${endpoint}`, {
          method: options.method ?? 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
          throw new GitHubApiError('GitHub API 请求超时。', 0, 'timeout', true);
        }
        throw new GitHubApiError('GitHub API 网络请求失败。', 0, 'network', true);
      }

      if (response.status === 401 && !refreshedUnauthorized) {
        refreshedUnauthorized = true;
        token = await this.options.tokenProvider.getToken(tokenOperation, { forceRefresh: true });
        continue;
      }

      const payload = response.status === 204 ? null : await response.json().catch(() => null) as GitHubErrorPayload | null;
      const rateLimited = isRateLimited(response, payload);
      if (rateLimited && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1;
        await this.sleep(getRetryDelay(response, this.now()));
        continue;
      }
      if (!response.ok) throw mapApiError(response, payload, rateLimited);
      return (payload ?? undefined) as T;
    }
  }
}
