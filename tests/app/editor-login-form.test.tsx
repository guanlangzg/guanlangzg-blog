import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorLoginForm } from '@/app/editor/login/EditorLoginForm';

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshMock,
    replace: replaceMock,
  }),
}));

describe('EditorLoginForm', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    replaceMock.mockReset();
    refreshMock.mockReset();

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

  it('keeps first-use setup locked when runtime setup is not enabled', () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled={false}
          setupTokenRequired={false}
          nextPath="/editor"
        />
      );
    });

    const loginInput = container.querySelector<HTMLInputElement>('#editor-login-secret');
    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');

    expect(container.textContent).toContain('服务器未开启首次初始化');
    expect(container.textContent).toContain('EDITOR_RUNTIME_AUTH_SETUP_TOKEN');
    expect(loginInput).toBeNull();
    expect(setupInput).toBeNull();
  });

  it('shows initialization guidance when runtime setup is enabled', () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled
          setupTokenRequired={false}
          nextPath="/editor"
        />
      );
    });

    const loginInput = container.querySelector<HTMLInputElement>('#editor-login-secret');
    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');
    const setupTokenInput = container.querySelector<HTMLInputElement>('#editor-setup-token');
    const confirmInput = container.querySelector<HTMLInputElement>('#editor-setup-confirm-secret');
    const submitButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('初始化并进入编辑区')
    );

    expect(container.textContent).toContain('初次使用初始化引导');
    expect(container.textContent).toContain('在这里设置一个新口令');
    expect(loginInput).toBeNull();
    expect(setupTokenInput).toBeNull();
    expect(setupInput?.disabled).toBe(false);
    expect(setupInput?.placeholder).toBe('至少 12 个字符');
    expect(confirmInput?.disabled).toBe(false);
    expect(submitButton?.disabled).toBe(true);
  });

  it('submits first-use initialization and enters the editor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled
          setupTokenRequired
          nextPath="/editor/settings"
        />
      );
    });

    const setupTokenInput = container.querySelector<HTMLInputElement>('#editor-setup-token');
    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');
    const confirmInput = container.querySelector<HTMLInputElement>('#editor-setup-confirm-secret');
    const form = container.querySelector('form');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    await act(async () => {
      valueSetter?.call(setupTokenInput, 'setup-token');
      setupTokenInput?.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(setupInput, 'new-secret-12');
      setupInput?.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(confirmInput, 'new-secret-12');
      confirmInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/editor-auth',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          secret: 'new-secret-12',
          confirmSecret: 'new-secret-12',
          setupToken: 'setup-token',
        }),
      })
    );
    expect(replaceMock).toHaveBeenCalledWith('/editor/settings');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('marks and focuses the setup secret when the first-use password is too short', async () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled
          setupTokenRequired={false}
          nextPath="/editor"
        />
      );
    });

    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');
    const confirmInput = container.querySelector<HTMLInputElement>('#editor-setup-confirm-secret');
    const form = container.querySelector('form');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    await act(async () => {
      valueSetter?.call(setupInput, 'short');
      setupInput?.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(confirmInput, 'short');
      confirmInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(setupInput).toBe(document.activeElement);
    expect(setupInput?.getAttribute('aria-invalid')).toBe('true');
    expect(setupInput?.getAttribute('aria-describedby')).toBe('editor-setup-error');
    expect(container.textContent).toContain('编辑口令至少需要 12 个字符。');

    await act(async () => {
      valueSetter?.call(setupInput, 'long-enough-12');
      setupInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(setupInput?.getAttribute('aria-invalid')).toBe('false');
    expect(setupInput?.getAttribute('aria-describedby')).toBeNull();
  });

  it('marks and focuses the setup token when an initialization key is required', async () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled
          setupTokenRequired
          nextPath="/editor"
        />
      );
    });

    const setupTokenInput = container.querySelector<HTMLInputElement>('#editor-setup-token');
    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');
    const confirmInput = container.querySelector<HTMLInputElement>('#editor-setup-confirm-secret');
    const form = container.querySelector('form');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    await act(async () => {
      valueSetter?.call(setupInput, 'new-secret-12');
      setupInput?.dispatchEvent(new Event('input', { bubbles: true }));
      valueSetter?.call(confirmInput, 'new-secret-12');
      confirmInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(setupTokenInput).toBe(document.activeElement);
    expect(setupTokenInput?.getAttribute('aria-invalid')).toBe('true');
    expect(setupTokenInput?.getAttribute('aria-describedby')).toBe('editor-setup-error');
    expect(container.textContent).toContain('请输入初始化密钥。');
  });

  it('keeps the normal login form focused when editor auth is configured', () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured
          setupEnabled={false}
          setupTokenRequired={false}
          nextPath="/editor"
        />
      );
    });

    const input = container.querySelector<HTMLInputElement>('#editor-login-secret');
    const runtimeConfigLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/editor/login?next=%2Feditor%2Fsettings%2Fruntime"]'
    );

    expect(container.textContent).not.toContain('初次使用初始化引导');
    expect(container.textContent).toContain('运行时配置');
    expect(input?.disabled).toBe(false);
    expect(runtimeConfigLink?.textContent).toContain('登录后进入运行时配置');
  });

  it('keeps the home link touch friendly on mobile', () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured
          setupEnabled={false}
          setupTokenRequired={false}
          nextPath="/editor"
        />
      );
    });

    const homeLink = container.querySelector<HTMLAnchorElement>('a[href="/"]');

    expect(homeLink?.textContent).toBe('返回首页');
    expect(homeLink?.className).toContain('min-h-11');
    expect(homeLink?.className).toContain('min-w-11');
  });

  it('shows a read-only error when runtime auth config is invalid', () => {
    act(() => {
      root.render(
        <EditorLoginForm
          authConfigured={false}
          setupEnabled
          setupTokenRequired
          nextPath="/editor"
          authErrorMessage="编辑口令配置文件损坏，请修复或删除后重试。"
        />
      );
    });

    const loginInput = container.querySelector<HTMLInputElement>('#editor-login-secret');
    const setupInput = container.querySelector<HTMLInputElement>('#editor-setup-secret');

    expect(container.textContent).toContain('编辑口令配置文件损坏');
    expect(container.textContent).not.toContain('初次使用初始化引导');
    expect(loginInput).toBeNull();
    expect(setupInput).toBeNull();
  });
});
