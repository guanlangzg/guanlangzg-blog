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
    headers: { 'Content-Type': 'application/json' },
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
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('links directly to publishing and GitHub backup recovery workspaces without loading remote backup status', async () => {
    await act(async () => root.render(<EditorHomePage />));
    await flushPromises();

    const links = Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    expect(links).toContain('/editor/publishing');
    expect(links).toContain('/editor/backups');
    expect(container.textContent).toContain('GitHub 备份与恢复');
    expect(container.textContent).not.toContain('R2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps local restore available through an accessible file input', async () => {
    await act(async () => root.render(<EditorHomePage />));
    await flushPromises();

    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');

    expect(restoreInput).toBeInstanceOf(HTMLInputElement);
    expect(restoreInput?.accept).toBe('.json');
    expect(restoreInput?.className).toContain('sr-only');
    expect(restoreInput?.className).not.toContain('hidden');
  });

  it('shows the backend backup failure message when portable backup download is rejected', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse(
      {
        code: 'runtime_data_root_unavailable',
        message: '运行时数据目录不可用，请检查服务器数据目录路径和写入权限。',
      },
      { status: 503 }
    ));

    await act(async () => root.render(<EditorHomePage />));
    await flushPromises();
    await act(async () => getButtonByText(container, '备份数据').click());
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/data/backup', expect.objectContaining({
      cache: 'no-store',
      credentials: 'include',
      method: 'GET',
    }));
    expect(container.textContent).toContain('运行时数据目录不可用，请检查服务器数据目录路径和写入权限。');
    expect(container.textContent).not.toContain('备份失败，请稍后重试。');
  });

  it('shows the backend restore failure message when local restore is rejected', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ manifest: currentManifest }))
      .mockResolvedValueOnce(createJsonResponse(
        { message: '当前数据已被其他会话更新，请刷新后重新执行恢复。' },
        { status: 409 }
      ));

    await act(async () => root.render(<EditorHomePage />));
    await flushPromises();
    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');
    const backupPayload = new File(
      [JSON.stringify({ version: 1, data: { articles: [], navigation: [] } })],
      'backup.json',
      { type: 'application/json' }
    );
    expect(restoreInput).toBeInstanceOf(HTMLInputElement);
    Object.defineProperty(restoreInput, 'files', { configurable: true, value: [backupPayload] });

    await act(async () => restoreInput?.dispatchEvent(new Event('change', { bubbles: true })));
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/data/backup/current-manifest', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/data/backup', expect.objectContaining({ method: 'POST' }));
    expect(container.textContent).toContain('当前数据已被其他会话更新，请刷新后重新执行恢复。');
    expect(container.textContent).not.toContain('恢复失败，请确认备份文件格式正确。');
  });

  it('shows the encrypted-backup restore error message from the backend without replacing it', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ manifest: currentManifest }))
      .mockResolvedValueOnce(createJsonResponse(
        { message: '检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。' },
        { status: 400 }
      ));

    await act(async () => root.render(<EditorHomePage />));
    await flushPromises();
    const restoreInput = container.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择本地备份 JSON"]');
    const backupPayload = new File(
      [JSON.stringify({ magic: 'blog-navigation-encrypted-backup', version: 1 })],
      'backup.json',
      { type: 'application/json' }
    );
    Object.defineProperty(restoreInput, 'files', { configurable: true, value: [backupPayload] });

    await act(async () => restoreInput?.dispatchEvent(new Event('change', { bubbles: true })));
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(container.textContent).toContain('检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。');
    expect(container.textContent).not.toContain('恢复失败，请确认备份文件格式正确。');
  });
});
