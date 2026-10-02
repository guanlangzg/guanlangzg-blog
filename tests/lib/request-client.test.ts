import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { resetAppRuntimeConfigCacheForTests } from '@/lib/app-runtime-config';
import { getRequestClientId } from '@/lib/request-client';

const ORIGINAL_ENV = {
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  SKIP_IP_VALIDATION: process.env.SKIP_IP_VALIDATION,
};
const tempDirectories: string[] = [];

function createRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/editor-auth', { headers });
}

function configureTrustedProxies(value: string): void {
  process.env.TRUSTED_PROXY_IPS = value;
  resetAppRuntimeConfigCacheForTests();
}

beforeEach(() => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-request-client-'));
  tempDirectories.push(dataRoot);
  process.env.BLOG_DATA_ROOT = dataRoot;
  delete process.env.SKIP_IP_VALIDATION;
  resetAppRuntimeConfigCacheForTests();
});

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
  resetAppRuntimeConfigCacheForTests();
});

describe('trusted forwarded client identity', () => {
  it('resolves the client entry a single trusted proxy appended', () => {
    configureTrustedProxies('198.51.100.1');

    expect(getRequestClientId(createRequest({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores a client-forged leftmost entry in front of the trusted proxy', () => {
    configureTrustedProxies('198.51.100.1');

    expect(getRequestClientId(createRequest({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('skips a chain of trusted proxies before taking the client entry', () => {
    configureTrustedProxies('198.51.100.1,198.51.100.2');

    expect(getRequestClientId(createRequest({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 198.51.100.1' })))
      .toBe('203.0.113.7');
  });

  it('falls back to unknown when every XFF entry is a trusted proxy or XFF is absent', () => {
    configureTrustedProxies('198.51.100.1');

    expect(getRequestClientId(createRequest({ 'x-forwarded-for': '198.51.100.1' }))).toBe('unknown');
    expect(getRequestClientId(createRequest({}))).toBe('unknown');
  });

  it('keeps the leftmost entry as the identity under the explicit * opt-in', () => {
    configureTrustedProxies('*');

    expect(getRequestClientId(createRequest({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('1.2.3.4');
  });
});
