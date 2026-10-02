import { GitHubAppTokenManager } from '@/lib/github/app';
import { GitHubApiError, GitHubRestClient } from '@/lib/github/client';
import { readGitHubConnection, saveGitHubConnection, type GitHubConnectionStatus } from '@/lib/github/config';
import { loadGitHubPrivateKey } from '@/lib/github/secrets';
import type { JobHandler } from '@/lib/jobs/worker';

export type GitHubCheckFailure = Extract<GitHubConnectionStatus, 'permission_error' | 'private_required' | 'network_error' | 'installation_revoked'>;

export interface GitHubCheckOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

function classifyFailure(error: unknown): GitHubCheckFailure {
  if (error instanceof GitHubApiError) {
    if (error.category === 'permission' || error.category === 'conflict') return 'permission_error';
    if (error.category === 'not_found' || error.category === 'unauthorized') return 'installation_revoked';
    if (error.category === 'network' || error.category === 'timeout' || error.category === 'rate_limit') return 'network_error';
  }
  if (error instanceof Error && /private/i.test(error.message)) return 'private_required';
  return 'network_error';
}

function assertPrivate(role: string, value: { private: boolean }): void {
  if (!value.private) throw new Error(`GitHub ${role} repository must be private.`);
}

export async function checkPendingGitHubConnection(expectedRevision?: string, options: GitHubCheckOptions = {}): Promise<void> {
  const connection = await readGitHubConnection();
  if (!connection || connection.status !== 'pending') throw new Error('GitHub connection is not pending.');
  if (expectedRevision && connection.revision !== expectedRevision) return;

  try {
    const tokenProvider = new GitHubAppTokenManager({
      appId: connection.appId,
      installationId: connection.installationId,
      repositories: connection.repos,
      getPrivateKey: loadGitHubPrivateKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const client = new GitHubRestClient({
      repositories: connection.repos,
      tokenProvider,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const [pages, backup] = await Promise.all([
      client.getRepository('pages'),
      client.getRepository('backup'),
    ]);
    assertPrivate('backup', backup);
    const pagesInfo = await client.getGitHubPages();
    if (!pagesInfo.source || pagesInfo.source.branch !== pages.defaultBranch || pagesInfo.source.path !== '/') {
      throw new Error('GitHub Pages source is not configured for the expected branch and root path.');
    }

    const current = await readGitHubConnection();
    if (!current || current.status !== 'pending' || current.revision !== connection.revision) return;
    await saveGitHubConnection({ ...current, status: 'connected' });
  } catch (error) {
    const current = await readGitHubConnection();
    if (current && current.status === 'pending' && current.revision === connection.revision) {
      await saveGitHubConnection({ ...current, status: classifyFailure(error) });
    }
    throw error;
  }
}

export function createGitHubCheckJobHandler(): JobHandler {
  return async (job) => {
    if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) {
      throw new Error('GitHub check job input is invalid.');
    }
    const revision = (job.input as { revision?: unknown }).revision;
    await checkPendingGitHubConnection(typeof revision === 'string' ? revision : undefined);
  };
}
