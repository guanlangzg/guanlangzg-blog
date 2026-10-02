import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ session: vi.fn(), records: vi.fn(), jobs: vi.fn(), inputs: vi.fn(), revisions: vi.fn() }));
vi.mock('@/lib/editor-api-auth', () => ({ ensureEditorSession: mocks.session }));
vi.mock('@/lib/editor-runtime/adapters', () => ({ listEditorReleases: mocks.records, readDraftSnapshot: mocks.inputs, readDraftResourceRevisions: mocks.revisions }));
vi.mock('@/lib/jobs/store', () => ({ listJobs: mocks.jobs }));
vi.mock('@/lib/publishing/store', () => ({ parseStoredRelease: (value: unknown) => value }));
vi.mock('@/lib/editor-data-storage', () => ({ getEditorDataResourceManifest: (_name: string, value: unknown) => ({ revision: `rev-${JSON.stringify(value).length}`, hash: 'test' }) }));

import { GET as getReleases } from '@/app/api/editor/releases/route';
import { GET as getRevision } from '@/app/api/editor/publishing-revision/route';

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue(null);
  mocks.records.mockReset();
  mocks.jobs.mockReset().mockResolvedValue([]);
  mocks.inputs.mockReset();
  mocks.revisions.mockReset().mockReturnValue({ article: 'rev-articles', navigation: 'rev-navigation', settings: 'rev-settings', bootstrap: 'rev-bootstrap' });
});

describe('read-only publishing APIs', () => {
  it('lists release status and safe retry/backup metadata for an authenticated session', async () => {
    mocks.records.mockReturnValue([{ id: 'r1', scope: { kind: 'settings' }, status: 'failed', candidateDigest: 'c'.repeat(64), artifactDigest: 'a'.repeat(64), hasBackupProof: true, error: { code: 'DEPLOY_FAILED', retryable: true }, createdAt: 'now', updatedAt: 'now' }]);
    const response = await getReleases(new NextRequest('http://localhost/api/editor/releases'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const payload = await response.json();
    expect(payload).toMatchObject({ releases: [{ id: 'r1', status: 'failed', error: { retryable: true } }] });
    expect(mocks.jobs).toHaveBeenCalledOnce();
  });

  it('returns the retry job after the initial publish job has terminated', async () => {
    mocks.records.mockReturnValue([{ id: 'r1', scope: { kind: 'settings' }, status: 'deploying', candidateDigest: 'c'.repeat(64), artifactDigest: 'a'.repeat(64), backupProof: {}, publicCommitSha: 'd'.repeat(40), workflowRunId: 42, workflowRunAttempt: 2, retryFromAttempt: 1, error: null, createdAt: 'now', updatedAt: 'later' }]);
    mocks.jobs.mockResolvedValue([
      { id: 'publish-r1', type: 'publish', status: 'failed', input: { releaseId: 'r1' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:01:00.000Z' },
      { id: 'publish-r1-retry-1', type: 'publish', status: 'running', input: { releaseId: 'r1', retry: true, retryFromAttempt: 1 }, createdAt: '2026-10-01T00:02:00.000Z', updatedAt: '2026-10-01T00:02:00.000Z' },
    ]);

    const response = await getReleases(new NextRequest('http://localhost/api/editor/releases'));

    expect((await response.json()).releases[0].taskId).toBe('publish-r1-retry-1');
  });

  it('requires a session and reports current scope input revisions', async () => {
    mocks.session.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    expect((await getRevision(new NextRequest('http://localhost/api/editor/publishing-revision'))).status).toBe(401);
    mocks.session.mockResolvedValueOnce(null);
    mocks.inputs.mockReturnValue({ articles: [{ id: 'a' }], navigation: [], settings: {} });
    const response = await getRevision(new NextRequest('http://localhost/api/editor/publishing-revision'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('revisions.article');
  });
});
