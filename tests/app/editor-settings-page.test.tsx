import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditorSettingsPage from '@/app/editor/(authenticated)/settings/page';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

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

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }

  return button;
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

  it('loads Cloudflare R2 settings and submits sanitized configuration', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
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
          settings: {
            enabled: true,
            accountId: '11111111111111111111111111111111',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://11111111111111111111111111111111.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('Cloudflare R2');
    expect(container.textContent).toContain('配置完整');
    expect(container.textContent).toContain('已保存');

    const accountInput = container.querySelector<HTMLInputElement>('#r2-account-id');
    const accessKeyInput = container.querySelector<HTMLInputElement>('#r2-access-key-id');
    const secretInput = container.querySelector<HTMLInputElement>('#r2-secret-access-key');
    const form = container.querySelector<HTMLFormElement>('#cloudflare-r2-form');

    expect(accountInput?.value).toBe('0123456789abcdef0123456789abcdef');
    expect(accessKeyInput?.value).toBe('');
    expect(secretInput?.value).toBe('');

    await act(async () => {
      if (accountInput) {
        setInputValue(accountInput, '11111111111111111111111111111111');
      }
      if (accessKeyInput) {
        setInputValue(accessKeyInput, 'access-key');
      }
    });
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/data/cloudflare-r2',
      expect.objectContaining({
        method: 'PUT',
        body: expect.any(String),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body.settings).toEqual(
      expect.objectContaining({
        enabled: true,
        accountId: '11111111111111111111111111111111',
        bucket: 'blog-data',
        accessKeyId: 'access-key',
        secretAccessKey: '',
      })
    );
  });

  it('refreshes R2 settings form state when save is rejected by a stale revision', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: 'Cloudflare R2 配置已被其他会话更新，请刷新后重试。',
            settings: {
              enabled: true,
              accountId: '22222222222222222222222222222222',
              bucket: 'server-bucket',
              hasAccessKeyId: true,
              hasSecretAccessKey: true,
              prefix: 'server-prefix',
              endpoint: '',
              snapshotOnWrite: true,
            },
            revision: 'server-revision',
            status: {
              enabled: true,
              configured: true,
              bucket: 'server-bucket',
              prefix: 'server-prefix',
              endpoint: 'https://22222222222222222222222222222222.r2.cloudflarestorage.com',
              snapshotOnWrite: true,
              hasAccessKeyId: true,
              hasSecretAccessKey: true,
              source: 'file',
              message: null,
              securityWarning: null,
            },
            backupQueue: {
              pending: 0,
              failed: 0,
              failedTasks: [],
            },
            backupQueueMessage: null,
          },
          { status: 409 }
        )
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const accountInput = container.querySelector<HTMLInputElement>('#r2-account-id');
    const accessKeyInput = container.querySelector<HTMLInputElement>('#r2-access-key-id');
    const bucketInput = container.querySelector<HTMLInputElement>('#r2-bucket');
    const form = container.querySelector<HTMLFormElement>('#cloudflare-r2-form');

    expect(accountInput?.value).toBe('0123456789abcdef0123456789abcdef');
    expect(bucketInput?.value).toBe('blog-data');

    await act(async () => {
      if (accountInput) {
        setInputValue(accountInput, '11111111111111111111111111111111');
      }
      if (accessKeyInput) {
        setInputValue(accessKeyInput, 'stale-access-key');
      }
      if (bucketInput) {
        setInputValue(bucketInput, 'stale-bucket');
      }
    });
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('Cloudflare R2 配置已被其他会话更新，请刷新后重试。');
    expect(accountInput?.value).toBe('22222222222222222222222222222222');
    expect(bucketInput?.value).toBe('server-bucket');
    expect(container.textContent).toContain('配置完整');
  });

  it('disables remote R2 actions until saved settings are complete', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'file',
            message: 'R2 backup is enabled but required variables are missing.',
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('配置不完整');
    expect(getButtonByText(container, '同步云端').disabled).toBe(true);
    expect(getButtonByText(container, '云端恢复').disabled).toBe(true);
  });

  it('keeps visible focus affordance on R2 checkbox rows', async () => {
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
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('#cloudflare-r2-form input[type="checkbox"]'));

    expect(checkboxes).toHaveLength(2);

    for (const checkbox of checkboxes) {
      const label = checkbox.closest('label');

      expect(checkbox.className).toContain('h-5');
      expect(checkbox.className).toContain('w-5');
      expect(checkbox.className).toContain('shrink-0');
      expect(label?.className).toContain('focus-within:ring-2');
      expect(label?.className).toContain('focus-within:border-link');
    }
  });

  it('bootstraps Cloudflare R2 settings and clears the one-time global key', async () => {
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
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
            securityWarning: null,
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          bucketCreated: true,
          tokenName: 'blog-navigation-r2-test',
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: true,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: true,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const emailInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-auth-email');
    const globalKeyInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-global-api-key');
    const accountInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-account-id');
    const bucketInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-bucket');
    const snapshotCheckbox = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest('label')?.textContent?.includes('关闭时仅手动同步和恢复会写入时间快照。'));

    await act(async () => {
      if (emailInput) {
        setInputValue(emailInput, 'owner@example.com');
      }
      if (globalKeyInput) {
        setInputValue(globalKeyInput, 'global-key-should-clear');
      }
      if (accountInput) {
        setInputValue(accountInput, '0123456789abcdef0123456789abcdef');
      }
      if (bucketInput) {
        setInputValue(bucketInput, 'blog-data');
      }
      snapshotCheckbox?.click();
    });

    await act(async () => {
      getButtonByText(container, '一键配置 R2').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/data/cloudflare-r2/bootstrap',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    );

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body.bootstrap).toEqual(
      expect.objectContaining({
        authEmail: 'owner@example.com',
        globalApiKey: 'global-key-should-clear',
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'blog-data',
        prefix: 'blog-navigation',
        snapshotOnWrite: true,
      })
    );
    expect(container.querySelector<HTMLInputElement>('#r2-bootstrap-global-api-key')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('#r2-account-id')?.value).toBe('0123456789abcdef0123456789abcdef');
    expect(container.querySelector<HTMLInputElement>('#r2-bucket')?.value).toBe('blog-data');
    expect(container.textContent).toContain('Cloudflare R2 已自动配置完成。');
  });

  it('retries bootstrap with the latest revision after a stale revision conflict', async () => {
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
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
            securityWarning: null,
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: 'Cloudflare R2 配置已被其他会话更新，请刷新后重试。',
            revision: 'server-revision',
            settings: {
              enabled: true,
              accountId: '22222222222222222222222222222222',
              bucket: 'server-bucket',
              hasAccessKeyId: true,
              hasSecretAccessKey: true,
              prefix: 'server-prefix',
              endpoint: '',
              snapshotOnWrite: true,
            },
            status: {
              enabled: true,
              configured: true,
              bucket: 'server-bucket',
              prefix: 'server-prefix',
              endpoint: 'https://22222222222222222222222222222222.r2.cloudflarestorage.com',
              snapshotOnWrite: true,
              hasAccessKeyId: true,
              hasSecretAccessKey: true,
              source: 'file',
              message: null,
              securityWarning: null,
            },
            backupQueue: {
              pending: 0,
              failed: 0,
              failedTasks: [],
            },
            backupQueueMessage: null,
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          bucketCreated: false,
          settings: {
            enabled: true,
            accountId: '22222222222222222222222222222222',
            bucket: 'server-bucket',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'server-prefix',
            endpoint: '',
            snapshotOnWrite: true,
          },
          revision: 'next-revision',
          status: {
            enabled: true,
            configured: true,
            bucket: 'server-bucket',
            prefix: 'server-prefix',
            endpoint: 'https://22222222222222222222222222222222.r2.cloudflarestorage.com',
            snapshotOnWrite: true,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const emailInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-auth-email');
    const globalKeyInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-global-api-key');
    const bootstrapAccountInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-account-id');
    const bootstrapBucketInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-bucket');
    const bootstrapPrefixInput = container.querySelector<HTMLInputElement>('#r2-bootstrap-prefix');
    const mainAccountInput = container.querySelector<HTMLInputElement>('#r2-account-id');
    const mainBucketInput = container.querySelector<HTMLInputElement>('#r2-bucket');
    const mainPrefixInput = container.querySelector<HTMLInputElement>('#r2-prefix');
    const checkboxInputs = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const bootstrapSnapshotInput = checkboxInputs[0];
    const mainSnapshotInput = checkboxInputs[2];

    await act(async () => {
      if (emailInput) {
        setInputValue(emailInput, 'owner@example.com');
      }
      if (globalKeyInput) {
        setInputValue(globalKeyInput, 'global-key-should-clear');
      }
      if (bootstrapAccountInput) {
        setInputValue(bootstrapAccountInput, '0123456789abcdef0123456789abcdef');
      }
      if (bootstrapBucketInput) {
        setInputValue(bootstrapBucketInput, 'blog-data');
      }
    });

    await act(async () => {
      getButtonByText(container, '一键配置 R2').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('Cloudflare R2 配置已被其他会话更新，请刷新后重试。');
    expect(mainAccountInput?.value).toBe('22222222222222222222222222222222');
    expect(mainBucketInput?.value).toBe('server-bucket');
    expect(mainPrefixInput?.value).toBe('server-prefix');
    expect(bootstrapAccountInput?.value).toBe('22222222222222222222222222222222');
    expect(bootstrapBucketInput?.value).toBe('server-bucket');
    expect(bootstrapPrefixInput?.value).toBe('server-prefix');
    expect(bootstrapSnapshotInput?.checked).toBe(true);
    expect(mainSnapshotInput?.checked).toBe(true);
    expect(globalKeyInput?.value).toBe('global-key-should-clear');
    expect(container.textContent).toContain('配置完整');

    await act(async () => {
      getButtonByText(container, '一键配置 R2').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string);

    expect(body).toEqual({
      bootstrap: {
        authEmail: 'owner@example.com',
        globalApiKey: 'global-key-should-clear',
        accountId: '22222222222222222222222222222222',
        bucket: 'server-bucket',
        prefix: 'server-prefix',
        snapshotOnWrite: true,
      },
      revision: 'server-revision',
    });
    expect(container.querySelector<HTMLInputElement>('#r2-bootstrap-global-api-key')?.value).toBe('');
    expect(container.textContent).toContain('Cloudflare R2 已自动配置完成。');
  });

  it('marks and focuses the first missing R2 settings field on submit', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'file',
            message: null,
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    const accountInput = container.querySelector<HTMLInputElement>('#r2-account-id');
    const form = container.querySelector<HTMLFormElement>('#cloudflare-r2-form');

    expect(accountInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(accountInput).toBe(document.activeElement);
    expect(accountInput?.getAttribute('aria-invalid')).toBe('true');
    expect(accountInput?.getAttribute('aria-describedby')).toBe('r2-account-id-description');
    expect(container.querySelector('#r2-account-id-description')?.textContent).toBe('请填写 Cloudflare Account ID。');
    expect(container.textContent).toContain('请填写 Cloudflare Account ID。');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      if (accountInput) {
        setInputValue(accountInput, '0123456789abcdef0123456789abcdef');
      }
    });

    expect(accountInput?.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector('#r2-account-id-description')?.textContent).toBe('去 Cloudflare 账号概览页复制 Account ID；留空无法生成 R2 endpoint。');
  });

  it('disables site settings save when the runtime data directory is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: false,
          revision: null,
          settings: DEFAULT_SITE_SETTINGS,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: false,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
          },
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
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
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

  it('syncs remote backups from settings through the resource endpoint', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
          },
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
      root.render(<EditorSettingsPage />);
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

  it('shows failed R2 backup tasks and requeues them from settings', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
          },
          backupQueue: {
            pending: 0,
            failed: 1,
            failedTasks: [
              {
                id: 'failed-task',
                reason: 'articles-write',
                attempts: 3,
                lastAttemptAt: '2026-06-07T00:00:00.000Z',
                lastError: 'R2 temporarily unavailable.',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          retried: 1,
          backupQueue: {
            pending: 1,
            failed: 0,
            failedTasks: [],
          },
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('有 1 个 R2 备份任务失败');
    expect(container.textContent).toContain('R2 temporarily unavailable.');

    await act(async () => {
      getButtonByText(container, '重试失败备份').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/data/backup/remote/retry',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(container.textContent).toContain('已重新排队 1 个失败备份任务。');
    expect(container.textContent).toContain('有 1 个 R2 备份任务正在排队。');
    expect(container.textContent).toContain('当前队列：pending 1 / failed 0；系统会按顺序继续同步。');
  });

  it('shows a queue warning when retrying failed backups returns a structured queue error', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
          },
          backupQueue: {
            pending: 0,
            failed: 1,
            failedTasks: [
              {
                id: 'failed-task',
                reason: 'articles-write',
                attempts: 3,
                lastAttemptAt: '2026-06-07T00:00:00.000Z',
                lastError: 'R2 temporarily unavailable.',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            message: '云端备份队列状态文件损坏，请检查并修复。',
            backupQueue: null,
            backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
          },
          { status: 500 }
        )
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    await act(async () => {
      getButtonByText(container, '重试失败备份').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(container.textContent).toContain('云端备份队列状态文件损坏，请检查并修复。');
    expect(container.textContent).not.toContain('有 1 个 R2 备份任务失败');
  });

  it('shows a queue warning when R2 settings load without readable queue metadata', async () => {
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
            securityWarning: null,
          },
          backupQueue: null,
          backupQueueMessage: '云端备份队列状态文件损坏，请检查并修复。',
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('云端备份队列状态文件损坏，请检查并修复。');
    expect(container.textContent).not.toContain('有 1 个 R2 备份任务失败');
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
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
          },
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
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          persistent: true,
          settings: {
            enabled: false,
            accountId: '',
            bucket: '',
            accessKeyId: '',
            hasSecretAccessKey: false,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: false,
            configured: false,
            bucket: null,
            prefix: 'blog-navigation',
            endpoint: null,
            snapshotOnWrite: false,
            hasAccessKeyId: false,
            hasSecretAccessKey: false,
            source: 'default',
            message: null,
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

  it('warns when settings page remote restore succeeds but the follow-up snapshot sync fails', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal('confirm', confirmMock);
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
          persistent: true,
          settings: {
            enabled: true,
            accountId: '0123456789abcdef0123456789abcdef',
            bucket: 'blog-data',
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            prefix: 'blog-navigation',
            endpoint: '',
            snapshotOnWrite: false,
          },
          status: {
            enabled: true,
            configured: true,
            bucket: 'blog-data',
            prefix: 'blog-navigation',
            endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
            snapshotOnWrite: false,
            hasAccessKeyId: true,
            hasSecretAccessKey: true,
            source: 'file',
            message: null,
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
        })
      );

    await act(async () => {
      root.render(<EditorSettingsPage />);
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
});
