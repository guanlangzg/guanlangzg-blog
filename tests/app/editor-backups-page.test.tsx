import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackupsPage from '@/app/editor/(authenticated)/backups/page';

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">退出登录</button>,
}));

const fetchMock = vi.fn<typeof fetch>();
const commit = 'a'.repeat(40);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return found;
}

describe('BackupsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('distinguishes unavailable remote backup history from an empty history', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'unavailable', items: [], nextCursor: null, unavailableReason: 'remote_error' }));
    await act(async () => { root.render(<BackupsPage />); });
    await flush();
    expect(container.textContent).toContain('远端备份历史暂不可查询');
    expect(container.textContent).toContain('GitHub 远端备份当前不可查询');
    expect(container.textContent).not.toContain('暂无备份');
  });

  it('does not offer local proofs as remote restore backups', async () => {
    fetchMock.mockResolvedValueOnce(json({
      status: 'unavailable',
      items: [{ commitSha: commit, committedAt: '2026-10-01T00:00:00Z', digest: 'local-proof-digest', source: 'local-proof' }],
      nextCursor: null,
      unavailableReason: 'remote_error',
    }));
    await act(async () => { root.render(<BackupsPage />); });
    await flush();

    expect(container.textContent).toContain('远端备份历史暂不可查询');
    expect(container.textContent).toContain('GitHub 远端备份当前不可查询');
    expect(container.textContent).not.toContain(commit);
    expect(container.textContent).not.toContain('暂无备份');
    expect(container.querySelector('button')?.textContent).not.toContain('生成合并计划');
  });

  it('shows the nested API error message when the remote backup history fails', async () => {
    fetchMock.mockResolvedValueOnce(json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'GitHub 远端备份服务暂时不可用。',
        retryable: true,
        requestId: 'req-backup-list',
      },
    }, 500));

    await act(async () => { root.render(<BackupsPage />); });
    await flush();

    expect(container.textContent).toContain('远端备份历史暂不可查询');
    expect(container.textContent).toContain('GitHub 远端备份服务暂时不可用。');
  });

  it('shows the nested API error message when creating a backup fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: 'available', items: [], nextCursor: null }))
      .mockResolvedValueOnce(json({
        error: {
          code: 'GITHUB_NOT_READY',
          message: 'GitHub 连接尚未就绪。',
          retryable: false,
          requestId: 'req-backup-create',
        },
      }, 503));

    await act(async () => { root.render(<BackupsPage />); });
    await flush();

    await act(async () => { button('创建 GitHub 备份').click(); });
    await flush();

    expect(container.textContent).toContain('GitHub 连接尚未就绪。');
  });

  it('requires a choice for every conflict and submits the plan base revision', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: 'available', items: [{ commitSha: commit, committedAt: '2026-10-01T00:00:00Z', digest: 'sha256:digest', source: 'remote' }], nextCursor: null }))
      .mockResolvedValueOnce(json({ planId: 'plan-1', conflictCount: 1 }, 200))
      .mockResolvedValueOnce(json({ binding: { currentRevision: 'rev-1', backupCommit: commit }, added: { articles: [], navigation: [], settings: [], media: [] }, identical: { articles: [], navigation: [], settings: [], media: [] }, conflicts: [{ conflictId: 'c1', kind: 'article-id', summary: '当前文章与备份内容不同', resolutions: ['keep-current', 'use-backup', 'keep-both'], subject: {} }] }))
      .mockResolvedValueOnce(json({ generation: 'next-generation' }))
      .mockResolvedValueOnce(json({ status: 'available', items: [], nextCursor: null }));
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);

    await act(async () => { root.render(<BackupsPage />); });
    await flush();
    expect(container.textContent).toContain(commit);

    const choose = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('生成合并计划'));
    expect(choose).toBeDefined();
    await act(async () => { (choose as HTMLButtonElement).click(); });
    await flush();
    expect(container.textContent).toContain('恢复计划同步创建响应 HTTP 200；计划 plan-1，冲突 1 项。实际计划读取 HTTP 200。');
    expect(container.textContent).toContain('当前文章与备份内容不同');
    expect(button('应用合并恢复').disabled).toBe(true);

    const useBackup = [...container.querySelectorAll('input[type="radio"]')].find((item) => (item as HTMLInputElement).value === 'use-backup') as HTMLInputElement;
    await act(async () => { useBackup.click(); });
    expect(button('应用合并恢复').disabled).toBe(false);
    await act(async () => { button('应用合并恢复').click(); });
    await flush();

    expect(container.textContent).toContain('应用合并响应 HTTP 200；恢复世代 next-generation。当前数据已更新，尚未发布。');
    const applicationCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/plan-1/applications'));
    expect(JSON.parse(applicationCall?.[1]?.body as string)).toEqual({
      baseRevision: 'rev-1',
      choices: [{ conflictId: 'c1', resolution: 'use-backup' }],
    });
    expect(confirmMock).toHaveBeenCalledOnce();
  });
});
