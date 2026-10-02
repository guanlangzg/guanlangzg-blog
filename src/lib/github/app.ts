import { createSign } from 'node:crypto';
import type { GitHubRepositories } from '@/lib/github/config';
import { loadGitHubPrivateKey } from '@/lib/github/secrets';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const JWT_MAX_AGE_SECONDS = 600;
const JWT_CLOCK_SKEW_SECONDS = 60;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type GitHubTokenOperation = 'backup' | 'publish' | 'rerun';

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
}

export interface GitHubTokenProvider {
  getToken(operation: GitHubTokenOperation, options?: { forceRefresh?: boolean }): Promise<string>;
}

export interface GitHubAppTokenManagerOptions {
  appId: string;
  installationId: number;
  repositories: GitHubRepositories;
  getPrivateKey?: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

const OPERATION_SCOPES: Record<GitHubTokenOperation, {
  repository: keyof GitHubRepositories;
  permissions: Record<string, string>;
}> = {
  backup: {
    repository: 'backup',
    permissions: { contents: 'write' },
  },
  publish: {
    repository: 'pages',
    permissions: { contents: 'write', actions: 'read', pages: 'read' },
  },
  rerun: {
    repository: 'pages',
    permissions: { actions: 'write' },
  },
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const currentSeconds = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iat: currentSeconds - JWT_CLOCK_SKEW_SECONDS,
    exp: currentSeconds + JWT_MAX_AGE_SECONDS,
    iss: appId,
  }));
  const unsignedJwt = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  return `${unsignedJwt}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

function parseInstallationToken(value: unknown): GitHubInstallationToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitHub installation token 响应格式无效。');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.token !== 'string' || !record.token ||
    typeof record.expires_at !== 'string' || !Number.isFinite(Date.parse(record.expires_at)) ||
    typeof record.permissions !== 'object' || record.permissions === null || Array.isArray(record.permissions)
  ) {
    throw new Error('GitHub installation token 响应格式无效。');
  }

  return {
    token: record.token,
    expiresAt: record.expires_at,
    permissions: record.permissions as Record<string, string>,
  };
}

export class GitHubAppTokenManager implements GitHubTokenProvider {
  private readonly cache = new Map<GitHubTokenOperation, GitHubInstallationToken>();
  private readonly fetchImplementation: typeof fetch;
  private readonly getPrivateKey: () => Promise<string>;
  private readonly now: () => number;

  constructor(private readonly options: GitHubAppTokenManagerOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.getPrivateKey = options.getPrivateKey ?? loadGitHubPrivateKey;
    this.now = options.now ?? Date.now;
  }

  async getToken(operation: GitHubTokenOperation, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const cached = this.cache.get(operation);
    if (
      !options.forceRefresh && cached &&
      Date.parse(cached.expiresAt) - this.now() > TOKEN_REFRESH_SKEW_MS
    ) {
      return cached.token;
    }

    this.cache.delete(operation);
    const token = await this.requestInstallationToken(operation);
    this.cache.set(operation, token);
    return token.token;
  }

  private async requestInstallationToken(operation: GitHubTokenOperation): Promise<GitHubInstallationToken> {
    const privateKeyPem = await this.getPrivateKey();
    const jwt = createGitHubAppJwt(this.options.appId, privateKeyPem, this.now());
    const scope = OPERATION_SCOPES[operation];
    const repository = this.options.repositories[scope.repository];
    const response = await this.fetchImplementation(
      `${GITHUB_API_BASE_URL}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          repository_ids: [repository.id],
          permissions: scope.permissions,
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub installation token 请求失败（HTTP ${response.status}）。`);
    }
    return parseInstallationToken(await response.json() as unknown);
  }
}

export const githubAppTokenScopes = OPERATION_SCOPES;
