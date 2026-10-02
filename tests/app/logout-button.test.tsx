import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogoutButton } from '@/app/editor/components/LogoutButton';
import { EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER } from '@/lib/editor-auth';

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshMock,
    replace: replaceMock,
  }),
}));

describe('LogoutButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    replaceMock.mockReset();
    refreshMock.mockReset();

    document.cookie = `${EDITOR_CSRF_COOKIE}=logout-csrf-token; path=/`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.cookie = `${EDITOR_CSRF_COOKIE}=; Max-Age=0; path=/`;
    container.remove();
    vi.unstubAllGlobals();
  });

  it('sends the CSRF header when logging out', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));

    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<LogoutButton />);
    });

    const button = container.querySelector('button');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/editor-auth',
      expect.objectContaining({
        method: 'DELETE',
      })
    );
    expect(headers.get(EDITOR_CSRF_HEADER)).toBe('logout-csrf-token');
    expect(replaceMock).toHaveBeenCalledWith('/');
    expect(refreshMock).toHaveBeenCalled();
  });
});
