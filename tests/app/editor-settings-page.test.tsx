import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditorSettingsPage from '@/app/editor/(authenticated)/settings/page';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

vi.mock('@/app/editor/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">logout</button>,
}));

const fetchMock = vi.fn();

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setTextareaValue(input: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EditorSettingsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

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

  it('keeps the GitHub connection panel available without loading it automatically', async () => {
    fetchMock.mockResolvedValueOnce(createJsonResponse({
      persistent: true,
      revision: 'settings-revision',
      settings: DEFAULT_SITE_SETTINGS,
    }));

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('GitHub 连接');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/data/settings', expect.any(Object));
  });

  it('disables site settings save when the runtime data directory is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: false,
          revision: null,
          settings: DEFAULT_SITE_SETTINGS,
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('运行时数据目录不可用');
    const saveButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
      .filter((button) => button.textContent?.includes('保存设置'));

    expect(saveButtons).toHaveLength(2);
    expect(saveButtons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain('运行时数据目录不可用，当前无法保存。');
  });

  it('shows project and Docker version metadata in settings', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: true,
          revision: 'settings-revision',
          settings: DEFAULT_SITE_SETTINGS,
          version: {
            projectVersion: '2.0.1',
            displayVersion: 'v2.0.1-build.42',
            runtime: 'docker',
            docker: {
              enabled: true,
              imageTag: 'v2.0.1-build.42',
              revision: 'abcdef1234567890',
              buildTime: '2026-06-08T08:00:00Z',
            },
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('版本信息');
    expect(container.textContent).toContain('v2.0.1-build.42');
    expect(container.textContent).toContain('2.0.1');
    expect(container.textContent).toContain('Docker 镜像');
    expect(container.textContent).toContain('abcdef123456');
    expect(container.textContent).toContain('2026-06-08T08:00:00Z');
  });

  it('submits edited homepage intro card settings', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: true,
          revision: 'settings-revision',
          settings: DEFAULT_SITE_SETTINGS,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          revision: 'next-settings-revision',
          settings: {
            ...DEFAULT_SITE_SETTINGS,
            introCardTitle: '新的介绍标题',
            introCardDescription: '新的介绍说明',
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('首页右侧介绍卡片');
    expect(container.textContent).toContain('保存后刷新公开页面生效。');

    const titleInput = container.querySelector<HTMLInputElement>('#settings-introCardTitle');
    const descriptionInput = container.querySelector<HTMLTextAreaElement>('#settings-introCardDescription');
    const introCardToggle = container.querySelector<HTMLInputElement>('#settings-showIntroCard');
    const saveButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
      .filter((button) => button.textContent?.includes('保存设置'));

    expect(saveButtons).toHaveLength(2);
    expect(saveButtons.every((button) => !button.disabled)).toBe(true);
    expect(introCardToggle?.checked).toBe(true);

    await act(async () => {
      if (titleInput) {
        setInputValue(titleInput, '  新的介绍标题  ');
      }

      if (descriptionInput) {
        setTextareaValue(descriptionInput, '  新的介绍说明  ');
      }

      introCardToggle?.click();
    });
    await act(async () => {
      saveButtons.at(-1)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/data/settings',
      expect.objectContaining({
        method: 'PUT',
        body: expect.any(String),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body).toEqual(
      expect.objectContaining({
        revision: 'settings-revision',
        settings: expect.objectContaining({
          introCardTitle: '新的介绍标题',
          introCardDescription: '新的介绍说明',
          introCardMetaOneLabel: DEFAULT_SITE_SETTINGS.introCardMetaOneLabel,
          showIntroCard: false,
        }),
      })
    );
  });

  it('marks and focuses the first missing site settings field on submit', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: true,
          revision: 'settings-revision',
          settings: {
            ...DEFAULT_SITE_SETTINGS,
            siteName: '',
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const siteNameInput = container.querySelector<HTMLInputElement>('#settings-siteName');
    const form = container.querySelector<HTMLFormElement>('#site-settings-form');

    expect(siteNameInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(siteNameInput).toBe(document.activeElement);
    expect(siteNameInput?.getAttribute('aria-invalid')).toBe('true');
    expect(siteNameInput?.getAttribute('aria-describedby')).toBe('settings-siteName-description');
    expect(container.querySelector('#settings-siteName-description')?.textContent).toBe('请填写站点名称。');
    expect(container.textContent).toContain('请填写站点名称。');

    await act(async () => {
      if (siteNameInput) {
        setInputValue(siteNameInput, 'Restored Site Name');
      }
    });

    expect(siteNameInput?.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('#settings-siteName-description')?.textContent).toBe('用于浏览器标题和后台识别。');
  });

});
