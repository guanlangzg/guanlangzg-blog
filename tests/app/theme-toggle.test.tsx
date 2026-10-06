import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '@/app/components/theme/ThemeToggle';
import { THEME_INIT_SCRIPT } from '@/lib/theme-init-script';

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('theme initialization', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('applies the persisted dark theme before React renders anything', () => {
    window.localStorage.setItem('theme', 'dark');
    stubMatchMedia(false);

    new Function(THEME_INIT_SCRIPT)();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('hydrates a stored dark preference without a hydration mismatch', async () => {
    stubMatchMedia(false);

    // The server renders without access to localStorage; only the browser knows
    // about the stored dark preference.
    const serverHtml = renderToString(<ThemeToggle />);
    window.localStorage.setItem('theme', 'dark');

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    const recoverableErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let root: Root | null = null;

    await act(async () => {
      root = hydrateRoot(container, <ThemeToggle />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    const hydrationMessages = [
      ...recoverableErrors.map((error) => String(error)),
      ...consoleError.mock.calls.map((call) => call.map((value) => String(value)).join(' ')),
    ].join('\n');

    expect(hydrationMessages).not.toMatch(/hydrat|did not match|server rendered/i);
    expect(container.querySelector('button[aria-label="深色"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await act(async () => {
      root?.unmount();
    });
    consoleError.mockRestore();
    container.remove();
  });
});
