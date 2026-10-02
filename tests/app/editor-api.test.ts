import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getGitHub, PUT as putGitHub } from '@/app/api/editor/github/route';
import { POST as postGitHubCheck } from '@/app/api/editor/github/check/route';
import { POST as postBackup } from '@/app/api/editor/backups/route';
import { GET as getJob } from '@/app/api/editor/jobs/[id]/route';
import { POST as postRelease } from '@/app/api/editor/releases/route';
import { GET as getRelease } from '@/app/api/editor/releases/[id]/route';
import { GET as getHistory } from '@/app/api/editor/articles/[id]/history/route';
import { GET as getBackups } from '@/app/api/editor/backups/route';
import { POST as applyRestore } from '@/app/api/editor/restore-plans/[id]/applications/route';
import { readStoredRestorePlan, applyStoredRestorePlan } from '@/lib/editor-runtime/restore-plan-runtime';
import { ensureEditorSession, ensureEditorWriteRequest } from '@/lib/editor-api-auth';
import { getGitHubConnectionDto, readGitHubConnection, saveGitHubConnection } from '@/lib/github/config';
import { saveGitHubPrivateKey } from '@/lib/github/secrets';
import { enqueueCurrentGitHubBackup, listRemoteGitHubBackups } from '@/lib/github/backup-service';
import { createOrReuseActiveJob, listJobs } from '@/lib/jobs/store';
import { readRelease } from '@/lib/publishing/store';
import { createGitHubArticleHistoryApi, listArticleHistory } from '@/lib/history/articles';
import { EDITOR_JSON_BODY_LIMIT_BYTES } from '@/lib/api-json-body';
import { createEditorPublishingService } from '@/lib/editor-runtime/adapters';

vi.mock('@/lib/editor-runtime/adapters', () => ({
  createEditorPublishingService: vi.fn(),
  listRecordedBackupProofs: vi.fn(() => []),
}));

vi.mock('@/lib/editor-api-auth', () => ({
  ensureEditorSession: vi.fn(),
  ensureEditorWriteRequest: vi.fn(),
}));
vi.mock('@/lib/github/config', () => ({
  getGitHubConnectionDto: vi.fn(),
  readGitHubConnection: vi.fn(),
  saveGitHubConnection: vi.fn(),
  validateGitHubRepositories: vi.fn((value: unknown) => value),
}));
vi.mock('@/lib/github/secrets', () => ({ saveGitHubPrivateKey: vi.fn() }));
vi.mock('@/lib/github/app', () => ({
  GitHubAppTokenManager: class {
    getToken = vi.fn();
  },
}));
vi.mock('@/lib/github/backup-service', () => ({
  enqueueCurrentGitHubBackup: vi.fn(),
  listRemoteGitHubBackups: vi.fn(),
}));
vi.mock('@/lib/jobs/store', () => ({ listJobs: vi.fn(), createOrReuseActiveJob: vi.fn() }));
vi.mock('@/lib/publishing/store', () => ({ readRelease: vi.fn() }));
vi.mock('@/lib/history/articles', () => ({
  ArticleHistoryConflictError: class ArticleHistoryConflictError extends Error {},
  createGitHubArticleHistoryApi: vi.fn(),
  listArticleHistory: vi.fn(),
}));
vi.mock('@/lib/editor-runtime/restore-plan-runtime', () => ({
  readStoredRestorePlan: vi.fn(),
  applyStoredRestorePlan: vi.fn(),
}));

const mockEnsureEditorSession = vi.mocked(ensureEditorSession);
const mockEnsureEditorWriteRequest = vi.mocked(ensureEditorWriteRequest);
const mockGetGitHubConnectionDto = vi.mocked(getGitHubConnectionDto);
const mockReadGitHubConnection = vi.mocked(readGitHubConnection);
const mockSaveGitHubConnection = vi.mocked(saveGitHubConnection);
const mockSaveGitHubPrivateKey = vi.mocked(saveGitHubPrivateKey);
const mockEnqueueBackup = vi.mocked(enqueueCurrentGitHubBackup);
const mockListRemoteBackups = vi.mocked(listRemoteGitHubBackups);
const mockListJobs = vi.mocked(listJobs);
const mockCreateJob = vi.mocked(createOrReuseActiveJob);
const mockReadRelease = vi.mocked(readRelease);
const mockCreateHistoryApi = vi.mocked(createGitHubArticleHistoryApi);
const mockListArticleHistory = vi.mocked(listArticleHistory);
const mockCreatePublishingService = vi.mocked(createEditorPublishingService);
const mockReadStoredRestorePlan = vi.mocked(readStoredRestorePlan);
const mockApplyStoredRestorePlan = vi.mocked(applyStoredRestorePlan);
const mockCreateCandidate = vi.fn();

const repositories = {
  source: { owner: 'owner', name: 'source', id: 1 },
  pages: { owner: 'owner', name: 'pages', id: 2 },
  backup: { owner: 'owner', name: 'backup', id: 3 },
};

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

async function payload(response: Response): Promise<unknown> {
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEditorSession.mockResolvedValue(null);
  mockEnsureEditorWriteRequest.mockResolvedValue(null);
  mockGetGitHubConnectionDto.mockResolvedValue({
    privateKeyConfigured: true,
    appId: 'app-1',
    installationId: 11,
    repos: repositories,
    status: 'connected',
  });
  mockReadGitHubConnection.mockResolvedValue({
    appId: 'app-1',
    installationId: 11,
    repos: repositories,
    status: 'connected',
  });
  mockSaveGitHubConnection.mockResolvedValue({
    appId: 'app-1',
    installationId: 11,
    repos: repositories,
    status: 'pending',
  });
  mockSaveGitHubPrivateKey.mockResolvedValue(undefined);
  mockListRemoteBackups.mockResolvedValue({ items: [], nextCursor: null });
  mockEnqueueBackup.mockResolvedValue({
    id: 'job-1',
    type: 'backup',
    inputDigest: 'digest',
    input: { snapshotId: 'snapshot-1' },
    status: 'pending',
    attempt: 0,
    nextAttemptAt: '2026-09-30T00:00:00.000Z',
    claimedAt: null,
    remoteCommit: null,
    lastError: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  mockListJobs.mockResolvedValue([]);
  mockCreateCandidate.mockReset();
  mockReadStoredRestorePlan.mockReturnValue({
    schemaVersion: 1,
    planDigest: 'plan-digest',
    binding: { currentRevision: 'revision-1', backupCommit: 'backup', backupContentDigest: 'backup-digest', currentContentDigest: 'current-digest' },
    added: { articles: [], navigation: [], settings: [], media: [] },
    identical: { articles: [], navigation: [], settings: [], media: [] },
    conflicts: [],
  });
  mockApplyStoredRestorePlan.mockImplementation(async (_id, _revision, choices) => {
    if (mockReadStoredRestorePlan('plan-1').conflicts.some((conflict) => !choices.some((choice) => choice.conflictId === conflict.conflictId))) {
      throw new Error('missing conflict choice');
    }
    return { generation: 'generation-next' } as never;
  });
  mockCreatePublishingService.mockReturnValue({ createCandidate: mockCreateCandidate } as never);
  mockCreateJob.mockResolvedValue({
    id: 'github-check-job',
    type: 'github-check',
    inputDigest: 'check-digest',
    input: { revision: 'revision-1' },
    status: 'pending',
    attempt: 0,
    nextAttemptAt: '2026-09-30T00:00:00.000Z',
    claimedAt: null,
    remoteCommit: null,
    lastError: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  mockCreateHistoryApi.mockReturnValue({
    listCommits: vi.fn(),
    readFile: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('editor API contracts', () => {
  it('applies a restore synchronously only when the submitted revision matches its plan', async () => {
    const response = await applyRestore(request('http://localhost/api/editor/restore-plans/plan-1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: 'revision-1', choices: [] }),
    }), { params: Promise.resolve({ id: 'plan-1' }) });

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ generation: 'generation-next' });
    expect(mockApplyStoredRestorePlan).toHaveBeenCalledWith('plan-1', 'revision-1', []);
  });

  it('rejects a base revision that differs from the stored plan without applying', async () => {
    mockReadStoredRestorePlan.mockReturnValue({
      schemaVersion: 1,
      planDigest: 'plan-digest',
      binding: { currentRevision: 'revision-1', backupCommit: 'backup', backupContentDigest: 'backup-digest', currentContentDigest: 'current-digest' },
      added: { articles: [], navigation: [], settings: [], media: [] },
      identical: { articles: [], navigation: [], settings: [], media: [] },
      conflicts: [],
    });
    const response = await applyRestore(request('http://localhost/api/editor/restore-plans/plan-1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: 'revision-old', choices: [] }),
    }), { params: Promise.resolve({ id: 'plan-1' }) });

    expect(response.status).toBe(409);
    expect(mockApplyStoredRestorePlan).not.toHaveBeenCalled();
  });

  it('requires a choice for every conflict before starting restore', async () => {
    mockReadStoredRestorePlan.mockReturnValue({
      schemaVersion: 1,
      planDigest: 'plan-digest',
      binding: { currentRevision: 'revision-1', backupCommit: 'backup', backupContentDigest: 'backup-digest', currentContentDigest: 'current-digest' },
      added: { articles: [], navigation: [], settings: [], media: [] },
      identical: { articles: [], navigation: [], settings: [], media: [] },
      conflicts: [{ conflictId: 'conflict-1', kind: 'settings-field', summary: 'conflict', resolutions: ['keep-current', 'use-backup'], subject: { settingKey: 'siteName' } }],
    } as never);
    const response = await applyRestore(request('http://localhost/api/editor/restore-plans/plan-1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: 'revision-1', choices: [] }),
    }), { params: Promise.resolve({ id: 'plan-1' }) });

    expect(response.status).toBe(422);
    expect(mockApplyStoredRestorePlan).not.toHaveBeenCalled();
  });

  it('creates a candidate with the submitted scope and expected resource revision', async () => {
    mockCreateCandidate.mockResolvedValue({
      release: { id: 'release-1', status: 'building' },
      snapshot: {},
    });

    const response = await postRelease(request('http://localhost/api/editor/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'article', articleId: 'article-1', action: 'publish' },
        expectedRevision: 'revision-1',
      }),
    }));

    expect(response.status).toBe(202);
    expect(await payload(response)).toEqual({ releaseId: 'release-1', status: 'building' });
    expect(mockCreateCandidate).toHaveBeenCalledWith(
      { kind: 'article', articleId: 'article-1', action: 'publish' },
      'revision-1',
    );
  });

  it('rejects candidate creation without an expected resource revision', async () => {
    const response = await postRelease(request('http://localhost/api/editor/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'settings' } }),
    }));

    expect(response.status).toBe(400);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'INVALID_REQUEST', retryable: false }),
    });
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('returns the documented auth failure before reading GitHub configuration', async () => {
    mockEnsureEditorSession.mockResolvedValue(NextResponse.json({ message: 'unauthorized' }, { status: 401 }));

    const response = await getGitHub(request('http://localhost/api/editor/github'));

    expect(response.status).toBe(401);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'AUTH_REQUIRED', retryable: false, requestId: expect.any(String) }),
    });
    expect(mockGetGitHubConnectionDto).not.toHaveBeenCalled();
  });

  it('returns the documented CSRF failure before saving GitHub settings', async () => {
    mockEnsureEditorWriteRequest.mockResolvedValue(NextResponse.json({ message: 'csrf' }, { status: 403 }));

    const response = await putGitHub(request('http://localhost/api/editor/github', {
      method: 'PUT',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(403);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'CSRF_FAILED', retryable: false, requestId: expect.any(String) }),
    });
    expect(mockSaveGitHubConnection).not.toHaveBeenCalled();
  });

  it('returns a no-store GitHub DTO without a private-key marker', async () => {
    const response = await getGitHub(request('http://localhost/api/editor/github'));
    const body = JSON.stringify(await payload(response));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body).not.toContain('PRIVATE_KEY_MARKER');
    expect(JSON.parse(body)).toEqual(expect.objectContaining({ privateKeyConfigured: true }));
  });

  it('accepts an optional private-key update without echoing it', async () => {
    const response = await putGitHub(request('http://localhost/api/editor/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'app-1',
        installationId: 11,
        repos: repositories,
        privateKeyPem: 'PRIVATE_KEY_MARKER',
      }),
    }));
    const body = JSON.stringify(await payload(response));

    expect(response.status).toBe(200);
    expect(mockSaveGitHubPrivateKey).toHaveBeenCalledWith('PRIVATE_KEY_MARKER');
    expect(mockSaveGitHubConnection).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
    expect(body).not.toContain('PRIVATE_KEY_MARKER');
  });

  it('queues a GitHub connection check with the current configuration revision', async () => {
    mockReadGitHubConnection.mockResolvedValue({
      appId: 'app-1',
      installationId: 11,
      repos: repositories,
      status: 'pending',
      revision: 'revision-1',
    });

    const response = await postGitHubCheck(request('http://localhost/api/editor/github/check', { method: 'POST' }));

    expect(response.status).toBe(202);
    expect(await payload(response)).toEqual({ jobId: 'github-check-job', status: 'pending' });
    expect(mockCreateJob).toHaveBeenCalledWith({ type: 'github-check', input: { revision: 'revision-1' } });
  });

  it('does not queue a GitHub check when the saved configuration is not pending', async () => {
    const response = await postGitHubCheck(request('http://localhost/api/editor/github/check', { method: 'POST' }));

    expect(response.status).toBe(409);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('returns remote commit metadata with cursor pagination and a local proof clearly marked', async () => {
    mockListRemoteBackups.mockResolvedValue({
      items: [{ commitSha: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00.000Z', digest: null }],
      nextCursor: 'a'.repeat(40),
    });
    const response = await getBackups(request('http://localhost/api/editor/backups?limit=7&cursor=2'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await payload(response)).toEqual({
      status: 'available',
      items: [{ commitSha: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00.000Z', digest: null, source: 'remote' }],
      nextCursor: 'a'.repeat(40),
    });
    expect(mockListRemoteBackups).toHaveBeenCalledWith({ cursor: '2', limit: 7 });
  });

  it('returns explicit unavailable state when GitHub is not connected', async () => {
    mockReadGitHubConnection.mockResolvedValue({ appId: 'app-1', installationId: 11, repos: repositories, status: 'pending' });
    const response = await getBackups(request('http://localhost/api/editor/backups'));

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'not_connected' });
    expect(mockListRemoteBackups).not.toHaveBeenCalled();
  });

  it('returns explicit unavailable state on remote errors instead of an empty success list', async () => {
    mockListRemoteBackups.mockRejectedValue(new Error('remote failed'));
    mockReadGitHubConnection.mockResolvedValue({ appId: 'app-1', installationId: 11, repos: repositories, status: 'connected' });
    const response = await getBackups(request('http://localhost/api/editor/backups'));

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'remote_error' });
  });

  it('rejects invalid backup pagination parameters', async () => {
    const response = await getBackups(request('http://localhost/api/editor/backups?limit=101'));
    expect(response.status).toBe(400);
    expect(mockListRemoteBackups).not.toHaveBeenCalled();
  });

  it('returns the queued backup job and snapshot IDs', async () => {
    const response = await postBackup(request('http://localhost/api/editor/backups', { method: 'POST' }));

    expect(response.status).toBe(202);
    expect(await payload(response)).toEqual({ jobId: 'job-1', snapshotId: 'snapshot-1' });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('looks up a job without exposing its input, claim token, or local paths', async () => {
    mockListJobs.mockResolvedValue([{
      id: 'job-secret',
      type: 'backup',
      inputDigest: 'digest',
      input: { secret: 'PRIVATE_KEY_MARKER', path: 'C:\\private\\data' },
      status: 'failed',
      attempt: 2,
      nextAttemptAt: '2026-09-30T00:00:00.000Z',
      claimedAt: null,
      claimToken: 'CLAIM_TOKEN_MARKER',
      remoteCommit: null,
      lastError: 'failed at C:\\private\\data',
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    }]);

    const response = await getJob(request('http://localhost/api/editor/jobs/job-secret'), {
      params: Promise.resolve({ id: 'job-secret' }),
    });
    const body = JSON.stringify(await payload(response));

    expect(response.status).toBe(200);
    expect(body).not.toContain('PRIVATE_KEY_MARKER');
    expect(body).not.toContain('CLAIM_TOKEN_MARKER');
    expect(body).not.toContain('C:\\private\\data');
  });

  it('returns release metadata but never its frozen snapshot', async () => {
    mockReadRelease.mockReturnValue({
      release: {
        schemaVersion: 1,
        id: 'release-1',
        scope: { kind: 'settings' },
        baseLiveReleaseId: null,
        selectedRevision: 'a'.repeat(64),
        candidateDigest: 'b'.repeat(64),
        artifactDigest: null,
        status: 'building',
        backupProof: null,
        publicCommitSha: null,
        workflowRunId: null,
        workflowRunAttempt: null,
        retryFromAttempt: null,
        error: null,
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      },
      snapshot: { privateContent: 'PRIVATE_SNAPSHOT_MARKER' },
    } as never);

    const response = await getRelease(request('http://localhost/api/editor/releases/release-1'), {
      params: Promise.resolve({ id: 'release-1' }),
    });
    const body = JSON.stringify(await payload(response));

    expect(response.status).toBe(200);
    expect(body).toContain('release-1');
    expect(body).not.toContain('PRIVATE_SNAPSHOT_MARKER');
  });

  it('paginates article history using cursor and limit', async () => {
    mockReadGitHubConnection.mockResolvedValue({ appId: 'app-1', installationId: 11, repos: repositories, status: 'connected' });
    mockListArticleHistory.mockResolvedValue({
      articleId: 'article-1',
      page: 2,
      perPage: 7,
      nextPage: 3,
      versions: [{
        commitSha: 'commit-1',
        message: 'Saved',
        committedAt: '2026-09-30T00:00:00.000Z',
        article: {
          id: 'article-1', slug: 'article-one', title: 'Article One', content: 'saved content',
          date: '2026-09-30', description: '', tags: [], createdAt: 1, updatedAt: 2, status: 'draft',
        },
        summary: {
          title: 'Article One', slug: 'article-one', updatedAt: 2, content: 'saved content',
          contentDigest: 'a'.repeat(64), metadataDigest: 'b'.repeat(64),
        },
      }],
    } as never);

    const response = await getHistory(request('http://localhost/api/editor/articles/article-1/history?cursor=2&limit=7'), {
      params: Promise.resolve({ id: 'article-1' }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await payload(response)).toEqual(expect.objectContaining({
      items: [expect.objectContaining({ commitSha: 'commit-1' })],
      nextCursor: '3',
    }));
    expect(mockListArticleHistory).toHaveBeenCalledWith(expect.any(Object), 'article-1', { page: 2, perPage: 7 });
  });

  it('rejects an oversized GitHub JSON body with the standard error envelope', async () => {
    const response = await putGitHub(request('http://localhost/api/editor/github', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(EDITOR_JSON_BODY_LIMIT_BYTES + 1),
      },
      body: '{}',
    }));

    expect(response.status).toBe(413);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'BODY_TOO_LARGE', retryable: false, requestId: expect.any(String) }),
    });
    expect(mockSaveGitHubConnection).not.toHaveBeenCalled();
  });

  it('returns the standard invalid JSON envelope without saving GitHub settings', async () => {
    const response = await putGitHub(request('http://localhost/api/editor/github', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    }));

    expect(response.status).toBe(400);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'INVALID_JSON', retryable: false, requestId: expect.any(String) }),
    });
    expect(mockSaveGitHubConnection).not.toHaveBeenCalled();
  });

  it('returns a standard not-found failure for an unknown job ID', async () => {
    mockListJobs.mockResolvedValue([]);

    const response = await getJob(request('http://localhost/api/editor/jobs/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });

    expect(response.status).toBe(404);
    expect(await payload(response)).toEqual({
      error: expect.objectContaining({ code: 'RESOURCE_NOT_FOUND', retryable: false, requestId: expect.any(String) }),
    });
  });
});
