import { NextRequest } from 'next/server';
import {
  EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES,
  readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import { ensureEditorSession, ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { createEditorApiError, mapEditorApiError, normalizeEditorApiResponse, privateJson } from '@/lib/editor-api-errors';
import { getGitHubConnectionDto, saveGitHubConnection, validateGitHubRepositories, type GitHubRepositories } from '@/lib/github/config';
import { saveGitHubPrivateKey } from '@/lib/github/secrets';

type GitHubSettingsBody = {
  appId?: unknown;
  installationId?: unknown;
  repos?: unknown;
  privateKeyPem?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGitHubSettings(value: unknown): {
  appId: string;
  installationId: number;
  repos: GitHubRepositories;
  privateKeyPem?: string;
} | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !['appId', 'installationId', 'repos', 'privateKeyPem'].includes(key))) return null;
  const repos = value.repos;
  if (!isRecord(repos)) return null;
  const roles = ['source', 'pages', 'backup'] as const;
  if (roles.some((role) => {
    const repo = repos[role];
    return !isRecord(repo) || typeof repo.owner !== 'string' || typeof repo.name !== 'string'
      || typeof repo.id !== 'number' || !Number.isSafeInteger(repo.id) || repo.id <= 0;
  })) return null;
  if (typeof value.appId !== 'string' || !value.appId.trim()
      || typeof value.installationId !== 'number' || !Number.isSafeInteger(value.installationId) || value.installationId <= 0
      || (value.privateKeyPem !== undefined && typeof value.privateKeyPem !== 'string')) return null;
  return {
    appId: value.appId.trim(),
    installationId: value.installationId,
    repos: repos as unknown as GitHubRepositories,
    ...(typeof value.privateKeyPem === 'string' && value.privateKeyPem.trim() ? { privateKeyPem: value.privateKeyPem } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await ensureEditorSession(request);
    if (auth) return normalizeEditorApiResponse(auth);
    return privateJson(await getGitHubConnectionDto());
  } catch (error) {
    return mapEditorApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await ensureEditorWriteRequest(request);
    if (auth) return normalizeEditorApiResponse(auth);
    const body = await readJsonBodyWithLimit<GitHubSettingsBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
    const settings = parseGitHubSettings(body);
    if (!settings) return createEditorApiError('INVALID_REQUEST', 400, { message: 'GitHub 设置格式无效。' });
    settings.repos = validateGitHubRepositories(settings.repos);
    if (settings.privateKeyPem) await saveGitHubPrivateKey(settings.privateKeyPem);
    await saveGitHubConnection({
      appId: settings.appId,
      installationId: settings.installationId,
      repos: settings.repos,
      status: 'pending',
    });
    return privateJson(await getGitHubConnectionDto());
  } catch (error) {
    return mapEditorApiError(error);
  }
}
