import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditorHomePage from '@/app/editor/(authenticated)/page';

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">logout</button>,
}));

const fetchMock = vi.fn();
const currentManifest = {
  version: 1,
  updatedAt: '2026-05-24T00:00:00.000Z',
  resources: {
    articles: {
      revision: 'articles-revision',
      hash: 'articles-hash',
      updatedAt: '2026-05-24T00:00:00.000Z',
    },
    navigation: {
      revision: 'navigation-revision',
      hash: 'navigation-hash',
      updatedAt: '2026-05-24T00:00:00.000Z',
    },
    settings: {
      revision: 'settings-revision',
      hash: 'settings-hash',
      updatedAt: '2026-05-24T00:00:00.000Z',
    },
  },
};

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }

  return button;
}

describe('EditorHomePage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('links directly to publishing and GitHub backup recovery workspaces', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse({ enabled: false, configured: false }));

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href'))).toContain('/editor/publishing');
    expect(Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href'))).toContain('/editor/backups');
    expect(container.textContent).toContain('GitHub 备份与恢复');
  });

  it('disables remote backup actions when R2 is not configured', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        enabled: false,
        configured: false,
      })
    );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup/remote',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
      })
    );
    expect(getButtonByText(container, '同步云端').disabled).toBe(true);
    expect(getButtonByText(container, '云端恢复').disabled).toBe(true);
    expect(container.textContent).toContain('R2 未配置完整，云端同步和云端恢复暂不可用。');
  });

  it('enables remote backup actions when R2 is configured', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        enabled: true,
        configured: true,
        backupQueue: {
          pending: 0,
          failed: 0,
          failedTasks: [],
        },
      })
    );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(getButtonByText(container, '同步云端').disabled).toBe(false);
    expect(getButtonByText(container, '云端恢复').disabled).toBe(false);
    expect(container.textContent).toContain('云端备份队列正常');
    expect(container.textContent).toContain('pending 0 / failed 0');
  });

  it('shows a queue warning when remote backup status loads without readable queue metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        enabled: true,
        configured: true,
        backupQueue: null,
        backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
      })
    );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('云端备份队列状态文件损坏，请检查并修复。');
    expect(container.textContent).not.toContain('云端备份队列正常');
  });

  it('shows the backend status error message when initial remote backup status loading fails', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse(
        {
          message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
        },
        { status: 500 }
      )
    );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(getButtonByText(container, '同步云端').disabled).toBe(true);
    expect(getButtonByText(container, '云端恢复').disabled).toBe(true);
    expect(container.textContent).toContain('Cloudflare R2 配置文件损坏，请修复或删除后重试。');
  });

  it('shows failed remote backup health and retries failed tasks', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
          backupQueue: {
            pending: 0,
            failed: 1,
            failedTasks: [
              {
                id: 'failed-task-1',
                reason: 'articles-write',
                attempts: 3,
                lastAttemptAt: '2026-06-08T00:00:00.000Z',
                lastError: 'R2 upload failed.',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          retried: 1,
          backupQueue: {
            pending: 1,
            failed: 0,
            failedTasks: [],
          },
        })
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('云端备份存在失败任务');
    expect(container.textContent).toContain('articles-write：R2 upload failed.');
    expect(getButtonByText(container, '重试失败').disabled).toBe(false);

    await act(async () => {
      getButtonByText(container, '重试失败').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup/remote/retry',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(container.textContent).toContain('失败的云端备份已重新加入队列。');
    expect(container.textContent).toContain('云端备份正在排队');
    expect(container.textContent).toContain('pending 1 / failed 0');
  });

  it('keeps local restore available through an accessible file input', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        enabled: false,
        configured: false,
      })
    );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');

    expect(restoreInput).toBeInstanceOf(HTMLInputElement);
    expect(restoreInput?.accept).toBe('.json');
    expect(restoreInput?.className).toContain('sr-only');
    expect(restoreInput?.className).not.toContain('hidden');
  });

  it('syncs remote backups through the resource endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          remoteBackup: {
            enabled: true,
            success: true,
          },
        })
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '同步云端').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup/remote/sync',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(container.textContent).toContain('云端备份已同步。');
  });

  it('shows the backend backup failure message when portable backup download is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: false,
          configured: false,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            code: 'runtime_data_root_unavailable',
            message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
          },
          { status: 503 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '备份数据').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        method: 'GET',
      })
    );
    expect(container.textContent).toContain('运行时数据目录不可用，请检查服务器数据目录路径和写入权限。');
    expect(container.textContent).not.toContain('备份失败，请稍后重试。');
  });

  it('shows the backend sync failure message from the resource endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
            backupQueue: null,
            backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
          },
          { status: 500 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '同步云端').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('Cloudflare R2 配置文件损坏，请修复或删除后重试。');
    expect(container.textContent).toContain('云端备份队列状态文件损坏，请检查并修复。');
    expect(container.textContent).not.toContain('云端备份存在失败任务');
  });

  it('warns when remote restore succeeds but the follow-up snapshot sync fails', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          manifest: currentManifest,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          remoteBackup: {
            enabled: true,
            success: false,
            message: 'R2 upload failed.',
          },
        })
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '云端恢复').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup/remote/restore',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentManifest }),
      })
    );
    expect(container.textContent).toContain('恢复成功，但云端快照同步失败：R2 upload failed.');
  });

  it('requeues the follow-up R2 sync after a successful local restore when snapshot upload fails', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
          backupQueue: {
            pending: 0,
            failed: 0,
            failedTasks: [],
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          manifest: currentManifest,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          remoteBackup: {
            enabled: true,
            success: false,
            message: 'R2 upload failed.',
          },
          backupQueue: {
            pending: 1,
            failed: 0,
            failedTasks: [],
          },
        })
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');
    const backupPayload = new File(
      [JSON.stringify({ version: 1, data: { articles: [], navigation: [] } })],
      'backup.json',
      { type: 'application/json' }
    );

    expect(restoreInput).toBeInstanceOf(HTMLInputElement);

    Object.defineProperty(restoreInput, 'files', {
      configurable: true,
      value: [backupPayload],
    });

    await act(async () => {
      restoreInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/backup',
      expect.objectContaining({
        method: 'POST',
      })
    );

    const restoreRequestBody = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(restoreRequestBody.currentManifest).toEqual(currentManifest);
    expect(container.textContent).toContain('恢复成功，但云端快照同步失败：R2 upload failed.');
    expect(container.textContent).toContain('云端备份正在排队');
    expect(container.textContent).toContain('pending 1 / failed 0');
  });

  it('shows the backend restore failure message when local restore is rejected', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          manifest: currentManifest,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '当前数据已被其他会话更新，请刷新后重新执行恢复。',
          },
          { status: 409 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');
    const backupPayload = new File(
      [JSON.stringify({ version: 1, data: { articles: [], navigation: [] } })],
      'backup.json',
      { type: 'application/json' }
    );

    expect(restoreInput).toBeInstanceOf(HTMLInputElement);

    Object.defineProperty(restoreInput, 'files', {
      configurable: true,
      value: [backupPayload],
    });

    await act(async () => {
      restoreInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(container.textContent).toContain('当前数据已被其他会话更新，请刷新后重新执行恢复。');
    expect(container.textContent).not.toContain('恢复失败，请确认备份文件格式正确。');
  });

  it('shows the encrypted-backup restore error message from the backend without replacing it', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          manifest: currentManifest,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。',
          },
          { status: 400 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');
    const backupPayload = new File(
      [JSON.stringify({ magic: 'blog-navigation-encrypted-backup', version: 1 })],
      'backup.json',
      { type: 'application/json' }
    );

    expect(restoreInput).toBeInstanceOf(HTMLInputElement);

    Object.defineProperty(restoreInput, 'files', {
      configurable: true,
      value: [backupPayload],
    });

    await act(async () => {
      restoreInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(container.textContent).toContain('检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。');
    expect(container.textContent).not.toContain('恢复失败，请确认备份文件格式正确。');
  });

  it('shows the backend restore failure message when cloud restore is rejected', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          manifest: currentManifest,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: 'R2 媒体文件不完整或校验失败，已取消恢复。',
          },
          { status: 502 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '云端恢复').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(container.textContent).toContain('R2 媒体文件不完整或校验失败，已取消恢复。');
  });

  it('shows the backend retry failure message when retrying failed tasks is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          enabled: true,
          configured: true,
          backupQueue: {
            pending: 0,
            failed: 1,
            failedTasks: [
              {
                id: 'failed-task-1',
                reason: 'articles-write',
                attempts: 3,
                lastAttemptAt: '2026-06-08T00:00:00.000Z',
                lastError: 'R2 upload failed.',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
          },
          { status: 500 }
        )
      );

    await act(async () => {
      root.render(<EditorHomePage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '重试失败').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('Cloudflare R2 配置文件损坏，请修复或删除后重试。');
  });
});
