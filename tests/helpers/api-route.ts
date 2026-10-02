import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as loginEditor } from '@/app/api/editor-auth/route';
import { EDITOR_CSRF_COOKIE, EDITOR_CSRF_HEADER, EDITOR_SESSION_COOKIE } from '@/lib/editor-auth';

export function createTempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTempDirectories(directories: string[]): void {
  while (directories.length > 0) {
    fs.rmSync(directories.pop() as string, { recursive: true, force: true });
  }
}

export function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const name of Object.keys(snapshot)) {
    const value = snapshot[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

export async function createAuthedEditorRequest(url: string, init?: RequestInit): Promise<NextRequest> {
  const token = process.env.EDITOR_ACCESS_TOKEN ?? '';
  const loginResponse = await loginEditor(new NextRequest('http://localhost/api/editor-auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ secret: token }),
  }));
  const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
  const csrfCookie = loginResponse.headers.get('set-cookie')
    ?.split(',')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${EDITOR_CSRF_COOKIE}=`))
    ?.split(';')[0] ?? '';

  if (loginResponse.status !== 200 || !sessionCookie.startsWith(`${EDITOR_SESSION_COOKIE}=`)) {
    throw new Error(`Failed to create authenticated editor request: status=${loginResponse.status}`);
  }

  const headers = new Headers(init?.headers);

  headers.set('Cookie', csrfCookie ? `${sessionCookie}; ${csrfCookie}` : sessionCookie);

  if (csrfCookie) {
    headers.set(EDITOR_CSRF_HEADER, csrfCookie.slice(`${EDITOR_CSRF_COOKIE}=`.length));
    headers.set('Origin', 'http://localhost');
  }

  return new NextRequest(url, {
    body: init?.body,
    method: init?.method,
    headers,
  });
}
