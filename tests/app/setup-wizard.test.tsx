import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from '@/app/setup/SetupWizard';

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshMock,
    replace: replaceMock,
  }),
}));

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createSetupLoadResponse() {
  return {
    authConfigured: false,
    setupEnabled: true,
    setupTokenRequired: false,
    editable: {
      publicSiteUrl: 'https://example.com',
      cookieSecure: false,
      trustedProxyIps: [],
      dataRootPath: '/var/lib/blog-navigation',
    },
    r2Settings: {
      enabled: false,
      accountId: '',
      bucket: '',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: false,
    },
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  valueSetter?.call(input, value);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('SetupWizard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(createJsonResponse(createSetupLoadResponse()));
    replaceMock.mockReset();
    refreshMock.mockReset();
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

  async function renderWizard(): Promise<void> {
    await act(async () => {
      root.render(<SetupWizard nextPath="/editor" />);
    });
    await flushPromises();
  }

  async function fillEditorSecret(): Promise<void> {
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('#setup-editor-secret'), 'new-runtime-secret-12');
      setInputValue(container.querySelector<HTMLInputElement>('#setup-confirm-editor-secret'), 'new-runtime-secret-12');
    });
  }

  it('blocks submit when R2 is skipped without explicit risk acceptance', async () => {
    await renderWizard();
    await fillEditorSecret();

    await act(async () => {
      container.querySelector<HTMLFormElement>('#setup-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('请配置 R2 远端备份，或点击“跳过并接受风险”。');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits disabled R2 settings after the risk warning is accepted', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse(createSetupLoadResponse()))
      .mockResolvedValueOnce(createJsonResponse({ success: true }));

    await renderWizard();
    await fillEditorSecret();

    await act(async () => {
      getButtonByText(container, '跳过并接受风险').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('#setup-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(confirmMock).toHaveBeenCalledWith(
      '数据风险：未配置 R2 备份，磁盘故障将导致全部内容丢失。确定跳过远端备份吗？'
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/setup',
      expect.objectContaining({
        method: 'PUT',
        body: expect.any(String),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body).toEqual(
      expect.objectContaining({
        r2SetupMode: 'disabled',
        r2Settings: expect.objectContaining({
          enabled: false,
        }),
      })
    );
    expect(replaceMock).toHaveBeenCalledWith('/editor');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('submits manual R2 setup without removed legacy secret fields', async () => {
    fetchMock
      .mockResolvedValueOnce(createJsonResponse(createSetupLoadResponse()))
      .mockResolvedValueOnce(createJsonResponse({ success: true }));

    await renderWizard();
    await fillEditorSecret();

    await act(async () => {
      getButtonByText(container, '配置 R2 备份').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      getButtonByText(container, '手动填写 R2 变量').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('#setup-r2-account-id'), '0123456789abcdef0123456789abcdef');
      setInputValue(container.querySelector<HTMLInputElement>('#setup-r2-bucket'), 'blog-data');
      setInputValue(container.querySelector<HTMLInputElement>('#setup-r2-access-key-id'), 'access-key');
      setInputValue(container.querySelector<HTMLInputElement>('#setup-r2-secret-access-key'), 'secret-key');
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('#setup-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body).toEqual(
      expect.objectContaining({
        r2SetupMode: 'manual',
        r2Settings: expect.objectContaining({
          enabled: true,
          accountId: '0123456789abcdef0123456789abcdef',
          bucket: 'blog-data',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        }),
      })
    );
  });

  it('blocks submit when runtime setup is disabled for first initialization', async () => {
    fetchMock.mockResolvedValue(createJsonResponse({
      ...createSetupLoadResponse(),
      setupEnabled: false,
    }));

    await renderWizard();
    await fillEditorSecret();

    const submitButton = getButtonByText(container, '完成初始化');

    expect(submitButton.disabled).toBe(true);
    expect(container.textContent).toContain('服务器未开启网页首次初始化');
  });
});
