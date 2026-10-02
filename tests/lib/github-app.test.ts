import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubAppJwt,
  GitHubAppTokenManager,
  type GitHubTokenOperation,
} from '@/lib/github/app';
import { GitHubRestClient } from '@/lib/github/client';
import type { GitHubRepositories } from '@/lib/github/config';
import { loadGitHubPrivateKey, saveGitHubPrivateKey } from '@/lib/github/secrets';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keyPair.publicKey;
const repositories: GitHubRepositories = {
  source: { owner: 'guanlangzg', name: 'guanlangzg-blog', id: 10 },
  pages: { owner: 'guanlangzg', name: 'guanlangzg.github.io', id: 20 },
  backup: { owner: 'guanlangzg', name: 'guanlangzg-blog-backup', id: 30 },
};

let previousDataRoot: string | undefined;
let previousSecretRoot: string | undefined;
let previousSecretKey: string | undefined;
let temporaryRoot: string;

function createTokenResponse(token: string, expiresAt: string): Response {
  return new Response(JSON.stringify({ token, expires_at: expiresAt, permissions: {} }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createRestClient(
  fetchImplementation: typeof fetch,
  getToken: (operation: GitHubTokenOperation, options?: { forceRefresh?: boolean }) => Promise<string>,
  sleep = vi.fn(async () => undefined)
): GitHubRestClient {
  return new GitHubRestClient({
    repositories,
    tokenProvider: { getToken },
    fetch: fetchImplementation,
    sleep,
  });
}

beforeEach(() => {
  previousDataRoot = process.env.BLOG_DATA_ROOT;
  previousSecretRoot = process.env.BLOG_SECRET_ROOT;
  previousSecretKey = process.env.BLOG_SECRET_KEY;
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-test-'));
  process.env.BLOG_DATA_ROOT = path.join(temporaryRoot, 'data');
  process.env.BLOG_SECRET_ROOT = path.join(temporaryRoot, 'secrets');
  process.env.BLOG_SECRET_KEY = randomBytes(32).toString('base64');
});

afterEach(() => {
  if (previousDataRoot === undefined) delete process.env.BLOG_DATA_ROOT;
  else process.env.BLOG_DATA_ROOT = previousDataRoot;
  if (previousSecretRoot === undefined) delete process.env.BLOG_SECRET_ROOT;
  else process.env.BLOG_SECRET_ROOT = previousSecretRoot;
  if (previousSecretKey === undefined) delete process.env.BLOG_SECRET_KEY;
  else process.env.BLOG_SECRET_KEY = previousSecretKey;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('GitHub App credentials and REST client', () => {
  it('creates an RS256 JWT with GitHub’s short validity window', () => {
    const now = 1_800_000_000_000;
    const jwt = createGitHubAppJwt('app-123', privateKey, now);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const signature = Buffer.from(encodedSignature, 'base64url');

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('app-123');
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBeGreaterThan(Math.floor(now / 1000));
    expect((payload.exp as number) - Math.floor(now / 1000)).toBeLessThanOrEqual(600);
    expect(verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, signature)).toBe(true);
  });

  it('caches installation tokens only until their expires_at safety window', async () => {
    let now = 1_800_000_000_000;
    let requests = 0;
    const fetchImplementation = vi.fn(async () => {
      requests += 1;
      return createTokenResponse(`token-${requests}`, new Date(now + 120_000).toISOString());
    });
    const manager = new GitHubAppTokenManager({
      appId: 'app-123',
      installationId: 44,
      repositories,
      getPrivateKey: async () => privateKey,
      fetch: fetchImplementation,
      now: () => now,
    });

    await expect(manager.getToken('backup')).resolves.toBe('token-1');
    await expect(manager.getToken('backup')).resolves.toBe('token-1');
    now += 61_000;
    await expect(manager.getToken('backup')).resolves.toBe('token-2');

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('requests distinct repository and permission scopes for backup, publish, and rerun', async () => {
    const requestBodies: Array<{ repository_ids: number[]; permissions: Record<string, string> }> = [];
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as typeof requestBodies[number]);
      return createTokenResponse(`token-${requestBodies.length}`, new Date(Date.now() + 3_600_000).toISOString());
    });
    const manager = new GitHubAppTokenManager({
      appId: 'app-123',
      installationId: 44,
      repositories,
      getPrivateKey: async () => privateKey,
      fetch: fetchImplementation,
    });

    await manager.getToken('backup');
    await manager.getToken('publish');
    await manager.getToken('rerun');

    expect(requestBodies).toEqual([
      { repository_ids: [30], permissions: { contents: 'write' } },
      { repository_ids: [20], permissions: { contents: 'write', actions: 'read', pages: 'read' } },
      { repository_ids: [20], permissions: { actions: 'write' } },
    ]);
  });

  it('fails closed without BLOG_SECRET_KEY and never stores an invalid key as plaintext', async () => {
    delete process.env.BLOG_SECRET_KEY;
    const suppliedKey = 'not-a-private-key-secret-marker';

    await expect(saveGitHubPrivateKey(suppliedKey)).rejects.toThrow('GitHub 配置未就绪');
    expect(fs.existsSync(path.join(process.env.BLOG_SECRET_ROOT as string, 'github-app-private-key.v1.json'))).toBe(false);

    process.env.BLOG_SECRET_KEY = randomBytes(32).toString('base64');
    let errorMessage = '';
    try {
      await saveGitHubPrivateKey(suppliedKey);
    } catch (error) {
      errorMessage = String(error);
    }
    expect(errorMessage).not.toContain(suppliedKey);
    expect(fs.existsSync(path.join(process.env.BLOG_SECRET_ROOT as string, 'github-app-private-key.v1.json'))).toBe(false);
    await expect(loadGitHubPrivateKey()).rejects.toThrow('尚未配置');
    expect(fs.existsSync(path.join(process.env.BLOG_SECRET_ROOT as string, 'github-app-private-key.v1.json'))).toBe(false);
  });

  it('refreshes a 401 exactly once, then returns a sanitized authentication error', async () => {
    const calls: Array<[GitHubTokenOperation, boolean | undefined]> = [];
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ message: privateKey }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    const rest = createRestClient(fetchImplementation, async (operation, options) => {
      calls.push([operation, options?.forceRefresh]);
      return options?.forceRefresh ? 'fresh-token' : 'old-token';
    });

    await expect(rest.getRepository('pages')).rejects.toMatchObject({
      status: 401,
      category: 'unauthorized',
    });
    expect(calls).toEqual([['publish', undefined], ['publish', true]]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    try {
      await rest.getRepository('pages');
    } catch (error) {
      expect(String(error)).not.toContain(privateKey);
    }
  });

  it('distinguishes permission 403 from rate-limit 403 and backs off using response headers', async () => {
    const sleep = vi.fn(async () => undefined);
    let rateLimitCalls = 0;
    const rateLimitedFetch = vi.fn(async () => {
      rateLimitCalls += 1;
      if (rateLimitCalls === 1) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        });
      }
      return new Response(JSON.stringify({ id: 20, name: 'guanlangzg.github.io', full_name: 'guanlangzg/guanlangzg.github.io', private: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const rateLimitedClient = createRestClient(rateLimitedFetch, async () => 'token', sleep);

    await expect(rateLimitedClient.getRepository('pages')).resolves.toMatchObject({ private: false });
    expect(sleep).toHaveBeenCalledWith(0);

    const permissionClient = createRestClient(async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }), async () => 'token');
    await expect(permissionClient.getRepository('pages')).rejects.toMatchObject({
      status: 403,
      category: 'permission',
    });
  });

  it('backs off for 429 responses and exposes only a rate-limit error after the retry budget', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi.fn(async () => new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '2' },
    }));
    const rest = createRestClient(fetchImplementation, async () => 'token', sleep);

    await expect(rest.getRepository('pages')).rejects.toMatchObject({
      status: 429,
      category: 'rate_limit',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});
