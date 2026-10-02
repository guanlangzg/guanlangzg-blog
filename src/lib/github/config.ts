import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { hasGitHubPrivateKey } from '@/lib/github/secrets';

export type GitHubRepositoryRole = 'source' | 'pages' | 'backup';
export type GitHubConnectionStatus = 'not_configured' | 'pending' | 'connected' | 'permission_error' | 'private_required' | 'network_error' | 'installation_revoked';
type PersistedGitHubConnectionStatus = Exclude<GitHubConnectionStatus, 'not_configured'>;

export interface GitHubRepositoryReference {
  owner: string;
  name: string;
  id: number;
}

export interface GitHubRepositories {
  source: GitHubRepositoryReference;
  pages: GitHubRepositoryReference;
  backup: GitHubRepositoryReference;
}

export interface GitHubConnectionInput {
  appId: string;
  installationId: number;
  repos: GitHubRepositories;
  status: PersistedGitHubConnectionStatus;
  revision?: string;
}

export interface GitHubConnectionDto {
  privateKeyConfigured: boolean;
  appId: string | null;
  installationId: number | null;
  repos: GitHubRepositories | null;
  status: GitHubConnectionStatus;
}

const CONNECTION_FILE_NAME = 'github.json';
const CONNECTION_FILE_VERSION = 1;

function normalizeRepository(repository: GitHubRepositoryReference, role: GitHubRepositoryRole): GitHubRepositoryReference {
  const owner = repository.owner.trim().toLowerCase();
  const name = repository.name.trim().toLowerCase();

  if (!owner || !name || !Number.isSafeInteger(repository.id) || repository.id <= 0) {
    throw new Error(`GitHub ${role} 仓库配置无效。`);
  }

  return { owner, name, id: repository.id };
}

function repositoryKey(repository: GitHubRepositoryReference): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}

export function validateGitHubRepositories(repositories: GitHubRepositories): GitHubRepositories {
  const normalized: GitHubRepositories = {
    source: normalizeRepository(repositories.source, 'source'),
    pages: normalizeRepository(repositories.pages, 'pages'),
    backup: normalizeRepository(repositories.backup, 'backup'),
  };
  const keys = {
    source: repositoryKey(normalized.source),
    pages: repositoryKey(normalized.pages),
    backup: repositoryKey(normalized.backup),
  };

  if (keys.backup === keys.source || (normalized.backup.id > 0 && normalized.backup.id === normalized.source.id)) {
    throw new Error('备份仓库不能与源码仓库相同。');
  }

  if (keys.backup === keys.pages || (normalized.backup.id > 0 && normalized.backup.id === normalized.pages.id)) {
    throw new Error('备份仓库不能与 Pages 仓库相同。');
  }

  if (keys.source === keys.pages || (normalized.source.id > 0 && normalized.source.id === normalized.pages.id)) {
    throw new Error('源码仓库与 Pages 仓库必须不同。');
  }

  return normalized;
}

function getConnectionFilePath(): string {
  return path.join(getRuntimeDataRootPath(), 'workflow', CONNECTION_FILE_NAME);
}

function deriveLegacyRevision(input: { appId: string; installationId: number; repos: GitHubRepositories }): string {
  const normalized = JSON.stringify({
    appId: input.appId.trim(),
    installationId: input.installationId,
    repos: validateGitHubRepositories(input.repos),
  });
  return `legacy-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

function parseConnection(value: unknown): GitHubConnectionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitHub 连接配置格式无效。');
  }

  const record = value as Record<string, unknown>;
  if (
    record.version !== CONNECTION_FILE_VERSION ||
    typeof record.appId !== 'string' || !record.appId.trim() ||
    typeof record.installationId !== 'number' || !Number.isSafeInteger(record.installationId) || record.installationId <= 0 ||
    typeof record.repos !== 'object' || record.repos === null || Array.isArray(record.repos) ||
    typeof record.status !== 'string' || !['pending', 'connected', 'permission_error', 'private_required', 'network_error', 'installation_revoked'].includes(record.status)
  ) {
    throw new Error('GitHub 连接配置格式无效。');
  }

  return {
    appId: record.appId.trim(),
    installationId: record.installationId,
    repos: validateGitHubRepositories(record.repos as GitHubRepositories),
    status: record.status as PersistedGitHubConnectionStatus,
    revision: typeof record.revision === 'string' && record.revision.trim()
      ? record.revision.trim()
      : deriveLegacyRevision({
        appId: record.appId,
        installationId: record.installationId,
        repos: record.repos as GitHubRepositories,
      }),
  };
}

export async function readGitHubConnection(): Promise<GitHubConnectionInput | null> {
  try {
    const contents = await fs.readFile(getConnectionFilePath(), 'utf8');
    return parseConnection(JSON.parse(contents) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('GitHub 连接配置 JSON 无效。');
    throw error;
  }
}

export async function saveGitHubConnection(input: GitHubConnectionInput): Promise<GitHubConnectionInput> {
  const normalized: GitHubConnectionInput = {
    appId: input.appId.trim(),
    installationId: input.installationId,
    repos: validateGitHubRepositories(input.repos),
    status: input.status,
    revision: input.revision?.trim() || randomUUID(),
  };
  if (!normalized.appId || !Number.isSafeInteger(normalized.installationId) || normalized.installationId <= 0) {
    throw new Error('GitHub App 或安装 ID 无效。');
  }

  const filePath = getConnectionFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomically(filePath, { version: CONNECTION_FILE_VERSION, ...normalized }, { mode: 0o600 });
  return normalized;
}

export async function getGitHubConnectionDto(): Promise<GitHubConnectionDto> {
  const [connection, privateKeyConfigured] = await Promise.all([
    readGitHubConnection(),
    hasGitHubPrivateKey(),
  ]);
  return {
    privateKeyConfigured,
    appId: connection?.appId ?? null,
    installationId: connection?.installationId ?? null,
    repos: connection?.repos ?? null,
    status: connection?.status ?? 'not_configured',
  };
}

