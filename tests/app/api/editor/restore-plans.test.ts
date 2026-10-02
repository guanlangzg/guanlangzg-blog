import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { RestoreApplicationError } from '@/lib/restoring/apply';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/editor-api-auth', () => ({ ensureEditorWriteRequest: mocks.auth }));
vi.mock('@/lib/editor-runtime/restore-plan-runtime', () => ({ createStoredRestorePlan: mocks.create }));

import { POST } from '@/app/api/editor/restore-plans/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/editor/restore-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.create.mockReset();
});

describe('POST /api/editor/restore-plans', () => {
  it('returns the synchronously created plan ID and conflict count without advertising a job', async () => {
    mocks.create.mockResolvedValue({ plan: { conflicts: [{ conflictId: 'c1' }, { conflictId: 'c2' }] }, planId: 'plan-1' });

    const response = await POST(request({ backupCommit: 'a'.repeat(40) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ planId: 'plan-1', conflictCount: 2 });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns the authentication response without creating a plan', async () => {
    mocks.auth.mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const response = await POST(request({ backupCommit: 'a'.repeat(40) }));

    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('maps invalid input to an INVALID_BACKUP response', async () => {
    const response = await POST(request({ backupCommit: 'short' }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_BACKUP' } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('maps restore application errors to their API status and code', async () => {
    mocks.create.mockRejectedValue(new RestoreApplicationError(409, 'REVISION_CONFLICT', 'stale'));

    const response = await POST(request({ backupCommit: 'a'.repeat(40) }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });

  it('maps unexpected failures to retryable internal errors', async () => {
    mocks.create.mockRejectedValue(new Error('unexpected'));

    const response = await POST(request({ backupCommit: 'a'.repeat(40) }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', retryable: true } });
  });
});
