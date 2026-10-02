import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connection: vi.fn(), listRemote: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/editor-api-auth', () => ({ ensureEditorSession: mocks.auth, ensureEditorWriteRequest: mocks.auth }));
vi.mock('@/lib/github/config', () => ({ readGitHubConnection: mocks.connection }));
vi.mock('@/lib/github/backup-service', () => ({ listRemoteGitHubBackups: mocks.listRemote, enqueueCurrentGitHubBackup: mocks.enqueue }));

import { GET } from '@/app/api/editor/backups/route';

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.connection.mockReset().mockResolvedValue({ status: 'connected' });
  mocks.listRemote.mockReset();
});

describe('GET /api/editor/backups', () => {
  it('returns unavailable without presenting local proofs as remote restore choices', async () => {
    mocks.listRemote.mockRejectedValue(new Error('remote unavailable'));

    const response = await GET(new NextRequest('http://localhost/api/editor/backups'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'remote_error' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns only the remote list DTO when GitHub is available', async () => {
    mocks.listRemote.mockResolvedValue({ items: [{ commitSha: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00Z', digest: 'sha256:remote' }], nextCursor: '2' });

    const response = await GET(new NextRequest('http://localhost/api/editor/backups'));

    expect(await response.json()).toEqual({
      status: 'available',
      items: [{ commitSha: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00Z', digest: 'sha256:remote', source: 'remote' }],
      nextCursor: '2',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
