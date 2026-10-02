import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishingPage from '@/app/editor/(authenticated)/publishing/page';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
});

describe('publishing workbench', () => {
  it('creates a candidate using the selected scope and shows the release state', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ revisions: { article: 'revision-1', navigation: 'navigation-revision' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releaseId: 'rel-1', status: 'building' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [{ id: 'rel-1', scope: { kind: 'navigation' }, status: 'building', candidateDigest: 'a'.repeat(64), artifactDigest: null, hasBackupProof: false, error: null }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ revisions: { article: 'revision-1', navigation: 'navigation-revision' } }) });

    render(<PublishingPage />);
    await screen.findByText('发布记录');
    fireEvent.change(screen.getByLabelText('发布范围'), { target: { value: 'navigation' } });
    fireEvent.click(screen.getByRole('button', { name: '创建候选' }));

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/editor/releases' && call[1]?.method === 'POST')).toBe(true));
    const createRequest = fetchMock.mock.calls.find((call) => call[0] === '/api/editor/releases' && call[1]?.method === 'POST');
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest?.[1].body)).toMatchObject({ scope: { kind: 'navigation' }, expectedRevision: 'navigation-revision' });
    expect(await screen.findByText('候选 rel-1 已创建。')).toBeInTheDocument();
  });

  it('sends both server-provided digests when confirming a ready candidate', async () => {
    const ready = { id: 'rel-1', scope: { kind: 'settings' }, status: 'preview_ready', candidateDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), hasBackupProof: true, error: null };
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [ready] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ revisions: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ taskId: 'job-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [ready] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ revisions: {} }) });
    render(<PublishingPage />);
    const button = await screen.findByRole('button', { name: '确认发布' });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/editor/releases/rel-1/confirmation')).toBe(true));
    const confirmation = fetchMock.mock.calls.find((call) => call[0] === '/api/editor/releases/rel-1/confirmation');
    expect(confirmation).toBeDefined();
    expect(JSON.parse(confirmation?.[1].body)).toEqual({ candidateDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64) });
  });

  it('does not offer confirmation without a sealed artifact digest', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [{ id: 'rel-1', scope: { kind: 'settings' }, status: 'building', candidateDigest: 'a'.repeat(64), artifactDigest: null, hasBackupProof: false, error: null }] }) }).mockResolvedValue({ ok: true, json: async () => ({ revisions: { article: 'revision-1' } }) });
    render(<PublishingPage />);
    await waitFor(() => expect(screen.getByText('发布记录')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '确认发布' })).not.toBeInTheDocument();
  });
});
