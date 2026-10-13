import { createGitHubAppJwt } from '@/lib/github/app';
import { GitHubApiError } from '@/lib/github/client';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
const REPOSITORIES_PER_PAGE = 100;
const MAX_PAGES = 3;

export interface DiscoveredGitHubRepository {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export interface ListInstallationRepositoriesOptions {
  appId: string;
  installationId: number;
  privateKeyPem: string;
  fetch?: typeof fetch;
  now?: () => number;
}

function parseDiscoveredRepository(value: unknown): DiscoveredGitHubRepository | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0 ||
    typeof record.full_name !== 'string' || !record.full_name.includes('/')
  ) {
    return null;
  }

  const [owner = '', name = ''] = record.full_name.split('/', 2);
  if (!owner || !name) return null;

  return {
    id: record.id,
    owner,
    name,
    isPrivate: record.private === true,
    defaultBranch: typeof record.default_branch === 'string' && record.default_branch ? record.default_branch : 'main',
  };
}

function toApiError(response: Response, payload: { message?: string } | null): GitHubApiError {
  if (response.status === 401) {
    return new GitHubApiError('GitHub App 凭据被拒绝，请确认 App ID 与私钥匹配。', response.status, 'unauthorized', true);
  }
  if (response.status === 403) {
    return new GitHubApiError('GitHub App 没有执行该操作的权限。', response.status, 'permission', false);
  }
  if (response.status === 404) {
    return new GitHubApiError('GitHub App 安装不存在、已卸载或不可访问。', response.status, 'not_found', false);
  }
  if (response.status === 422) {
    return new GitHubApiError('GitHub 拒绝了仓库列表请求，请确认安装已授权至少一个仓库。', response.status, 'permission', false);
  }
  const detail = payload?.message ? `：${payload.message.slice(0, 160)}` : '';
  return new GitHubApiError(`GitHub API 请求失败（HTTP ${response.status}）${detail}`, response.status, 'http', response.status >= 500);
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new GitHubApiError('无法连接 GitHub API，请检查服务器网络或代理设置。', 0, 'network', true);
  }

  let payload: unknown = null;
  if (!response.ok) {
    payload = await response.json().catch(() => null);
    throw toApiError(response, payload as { message?: string } | null);
  }

  try {
    return await response.json();
  } catch {
    throw new GitHubApiError('GitHub API 响应格式无效。', 502, 'http', false);
  }
}

export async function listInstallationRepositories(
  options: ListInstallationRepositoriesOptions
): Promise<DiscoveredGitHubRepository[]> {
  const fetchImplementation = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  let jwt: string;
  try {
    jwt = createGitHubAppJwt(options.appId, options.privateKeyPem, now());
  } catch {
    throw new GitHubApiError('GitHub App 私钥无效，无法生成请求凭据。', 400, 'http', false);
  }

  const tokenPayload = await requestJson(fetchImplementation,
    `${GITHUB_API_BASE_URL}/app/installations/${options.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      // Omitting repository_ids grants the token to every repository the installation covers.
      body: JSON.stringify({ permissions: { contents: 'read' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const tokenRecord = tokenPayload as Record<string, unknown>;
  if (typeof tokenRecord.token !== 'string' || !tokenRecord.token) {
    throw new GitHubApiError('GitHub installation token 响应格式无效。', 502, 'http', false);
  }
  const installationToken = tokenRecord.token;

  const repositories: DiscoveredGitHubRepository[] = [];
  const seenIds = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pagePayload = await requestJson(fetchImplementation,
      `${GITHUB_API_BASE_URL}/installation/repositories?per_page=${REPOSITORIES_PER_PAGE}&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${installationToken}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    const records = (pagePayload as { repositories?: unknown }).repositories;
    if (!Array.isArray(records)) {
      throw new GitHubApiError('GitHub 安装仓库列表响应格式无效。', 502, 'http', false);
    }

    for (const record of records) {
      const parsed = parseDiscoveredRepository(record);
      if (parsed && !seenIds.has(parsed.id)) {
        seenIds.add(parsed.id);
        repositories.push(parsed);
      }
    }
    if (records.length < REPOSITORIES_PER_PAGE) break;
  }

  // Codepoint ordering keeps the display list deterministic across ICU builds.
  return repositories.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
}
