import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RuntimeSettingsPage from '@/app/editor/(authenticated)/settings/runtime/page';

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

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }

  return button;
}

describe('RuntimeSettingsPage', () => {
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

  it('marks and focuses the confirmation field when editor secrets do not match', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        editable: {
          publicSiteUrl: 'https://example.com',
          cookieSecure: true,
          trustedProxyIps: ['127.0.0.1'],
          dataRootPath: '/var/lib/blog-navigation',
        },
        config: {
          dataRoot: {
            pendingPath: null,
            requiresRestart: false,
          },
        },
      })
    );

    await act(async () => {
      root.render(<RuntimeSettingsPage />);
    });
    await flushPromises();

    const secretInput = container.querySelector<HTMLInputElement>('#runtime-editor-secret');
    const confirmInput = container.querySelector<HTMLInputElement>('#runtime-confirm-editor-secret');
    const form = container.querySelector<HTMLFormElement>('#runtime-config-form');

    expect(secretInput).toBeInstanceOf(HTMLInputElement);
    expect(confirmInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      setInputValue(secretInput as HTMLInputElement, 'new-runtime-secret-12');
      setInputValue(confirmInput as HTMLInputElement, 'different-runtime-secret-12');
    });

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(confirmInput?.getAttribute('aria-invalid')).toBe('true');
    expect(confirmInput?.getAttribute('aria-describedby')).toContain('runtime-confirm-editor-secret-error');
    expect(container.querySelector('#runtime-confirm-editor-secret-error')?.textContent).toContain('两次输入的编辑口令不一致');
    expect(document.activeElement).toBe(confirmInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows Docker version metadata on the runtime settings page', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        editable: {
          publicSiteUrl: 'https://example.com',
          cookieSecure: true,
          trustedProxyIps: ['127.0.0.1'],
          dataRootPath: '/var/lib/blog-navigation',
        },
        config: {
          dataRoot: {
            pendingPath: null,
            requiresRestart: false,
          },
        },
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
      root.render(<RuntimeSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('版本信息');
    expect(container.textContent).toContain('v2.0.1-build.42');
    expect(container.textContent).toContain('Docker 镜像');
    expect(container.textContent).toContain('abcdef123456');
  });

  it('refreshes runtime form state after a stale revision conflict and retries with the latest revision', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          editable: {
            publicSiteUrl: 'https://example.com',
            cookieSecure: true,
            trustedProxyIps: ['127.0.0.1'],
            dataRootPath: '/var/lib/blog-navigation',
          },
          config: {
            dataRoot: {
              pendingPath: null,
              requiresRestart: false,
            },
          },
          revision: 'settings-revision',
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
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '运行时配置已被其他会话更新，请刷新后重试。',
            editable: {
              publicSiteUrl: 'https://server.example.com',
              cookieSecure: false,
              trustedProxyIps: ['10.0.0.1'],
              dataRootPath: '/srv/blog-navigation',
            },
            config: {
              dataRoot: {
                pendingPath: '/srv/blog-navigation',
                requiresRestart: true,
              },
            },
            revision: 'server-revision',
            version: {
              projectVersion: '2.0.2',
              displayVersion: 'v2.0.2-build.43',
              runtime: 'docker',
              docker: {
                enabled: true,
                imageTag: 'v2.0.2-build.43',
                revision: 'bbbbbb1234567890',
                buildTime: '2026-06-09T08:00:00Z',
              },
            },
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          editable: {
            publicSiteUrl: 'https://server.example.com',
            cookieSecure: false,
            trustedProxyIps: ['10.0.0.1'],
            dataRootPath: '/srv/blog-navigation',
          },
          config: {
            dataRoot: {
              pendingPath: '/srv/blog-navigation',
              requiresRestart: true,
            },
          },
          revision: 'next-revision',
          version: {
            projectVersion: '2.0.2',
            displayVersion: 'v2.0.2-build.43',
            runtime: 'docker',
            docker: {
              enabled: true,
              imageTag: 'v2.0.2-build.43',
              revision: 'bbbbbb1234567890',
              buildTime: '2026-06-09T08:00:00Z',
            },
          },
        })
      );

    await act(async () => {
      root.render(<RuntimeSettingsPage />);
    });
    await flushPromises();

    const publicSiteUrlInput = container.querySelector<HTMLInputElement>('#runtime-public-site-url');
    const form = container.querySelector<HTMLFormElement>('#runtime-config-form');

    expect(publicSiteUrlInput?.value).toBe('https://example.com');

    await act(async () => {
      if (publicSiteUrlInput) {
        setInputValue(publicSiteUrlInput, 'https://stale.example.com');
      }
    });

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('运行时配置已被其他会话更新，请刷新后重试。');
    expect(publicSiteUrlInput?.value).toBe('https://server.example.com');
    expect(container.textContent).toContain('v2.0.2-build.43');

    await act(async () => {
      getButtonByText(container, '保存配置').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body.revision).toBe('server-revision');
    expect(container.textContent).toContain('运行时配置已保存。');
  });
});
