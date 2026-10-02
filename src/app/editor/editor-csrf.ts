import { EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER } from '@/lib/editor-auth';

function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const prefix = `${name}=`;
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
}

export function createEditorCsrfHeaders(headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers);
  const csrfToken = getCookieValue(EDITOR_CSRF_COOKIE);

  if (csrfToken) {
    nextHeaders.set(EDITOR_CSRF_HEADER, csrfToken);
  }

  return nextHeaders;
}
