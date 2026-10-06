import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetAppRuntimeConfigCacheForTests } from '@/lib/app-runtime-config';
import {
  clearEditorAuthFailures,
  getEditorAuthRateLimitResponse,
  recordEditorAuthFailure,
  resetEditorAuthRateLimitForTests,
} from '@/lib/editor-auth-rate-limit';
import {
  cleanupTempDirectories,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

// The limiter buckets on the client identity resolved by request-client.ts, so
// the tests pin a trusted proxy whose appended X-Forwarded-For segment yields a
// deterministic identity per client instead of one shared fallback bucket.
const TRUSTED_PROXY_IP = '203.0.113.1';
const AUTH_FAILURE_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  SKIP_IP_VALIDATION: process.env.SKIP_IP_VALIDATION,
};
const tempDirectories: string[] = [];

function createRequest(clientIp: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/editor-auth', {
    method: 'POST',
    headers: {
      'x-forwarded-for': `${clientIp}, ${TRUSTED_PROXY_IP}`,
      'user-agent': 'test-client',
    },
  });
}

function recordFailures(request: NextRequest, operation: 'login' | 'setup', times: number): void {
  for (let attempt = 0; attempt < times; attempt += 1) {
    recordEditorAuthFailure(request, operation);
  }
}

beforeEach(() => {
  process.env.BLOG_DATA_ROOT = createTempDirectory('blog-rate-limit-');
  tempDirectories.push(process.env.BLOG_DATA_ROOT);
  process.env.TRUSTED_PROXY_IPS = TRUSTED_PROXY_IP;
  delete process.env.SKIP_IP_VALIDATION;
  resetAppRuntimeConfigCacheForTests();
  resetEditorAuthRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetEditorAuthRateLimitForTests();
  restoreEnv(ORIGINAL_ENV);
  resetAppRuntimeConfigCacheForTests();
  cleanupTempDirectories(tempDirectories);
});

describe('Login rate limiting', () => {
  it('allows five failures and blocks the next login attempt', () => {
    const request = createRequest('198.51.100.10');

    for (let attempt = 0; attempt < AUTH_FAILURE_LIMIT; attempt += 1) {
      expect(getEditorAuthRateLimitResponse(request, 'login')).toBeNull();
      recordEditorAuthFailure(request, 'login');
    }

    const blocked = getEditorAuthRateLimitResponse(request, 'login');

    expect(blocked?.status).toBe(429);
  });

  it('isolates login failure counters per client identity', () => {
    const blockedClient = createRequest('198.51.100.10');
    const otherClient = createRequest('198.51.100.200');

    recordFailures(blockedClient, 'login', AUTH_FAILURE_LIMIT);

    expect(getEditorAuthRateLimitResponse(blockedClient, 'login')?.status).toBe(429);
    expect(getEditorAuthRateLimitResponse(otherClient, 'login')).toBeNull();
  });

  it('clears the login failure budget after a successful login', () => {
    const request = createRequest('198.51.100.10');

    recordFailures(request, 'login', AUTH_FAILURE_LIMIT);
    expect(getEditorAuthRateLimitResponse(request, 'login')?.status).toBe(429);

    clearEditorAuthFailures(request, 'login');

    expect(getEditorAuthRateLimitResponse(request, 'login')).toBeNull();
  });

  it('keeps login and setup counters independent for the same client', () => {
    const request = createRequest('198.51.100.10');

    recordFailures(request, 'login', AUTH_FAILURE_LIMIT);

    expect(getEditorAuthRateLimitResponse(request, 'login')?.status).toBe(429);
    expect(getEditorAuthRateLimitResponse(request, 'setup')).toBeNull();
  });
});

describe('Setup rate limiting', () => {
  it('blocks after five failed setup attempts with the rate limit message', async () => {
    const request = createRequest('198.51.100.10');

    recordFailures(request, 'setup', AUTH_FAILURE_LIMIT);

    const response = getEditorAuthRateLimitResponse(request, 'setup');
    const body = await response?.json();

    expect(response?.status).toBe(429);
    expect(body?.message).toContain('尝试次数过多');
  });

  it('isolates setup failure counters per client identity', () => {
    const blockedClient = createRequest('198.51.100.10');
    const otherClient = createRequest('198.51.100.200');

    recordFailures(blockedClient, 'setup', AUTH_FAILURE_LIMIT);

    expect(getEditorAuthRateLimitResponse(blockedClient, 'setup')?.status).toBe(429);
    expect(getEditorAuthRateLimitResponse(otherClient, 'setup')).toBeNull();
  });
});

describe('Rate limit window', () => {
  it('expires the login failure budget 15 minutes after the first failure', () => {
    vi.useFakeTimers();

    const request = createRequest('198.51.100.10');

    recordFailures(request, 'login', AUTH_FAILURE_LIMIT);
    expect(getEditorAuthRateLimitResponse(request, 'login')?.status).toBe(429);

    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(getEditorAuthRateLimitResponse(request, 'login')?.status).toBe(429);

    vi.advanceTimersByTime(1);
    expect(getEditorAuthRateLimitResponse(request, 'login')).toBeNull();
  });

  it('starts a fresh window from the first failure after expiry', () => {
    vi.useFakeTimers();

    const request = createRequest('198.51.100.10');

    recordFailures(request, 'login', AUTH_FAILURE_LIMIT);
    vi.advanceTimersByTime(WINDOW_MS);

    expect(getEditorAuthRateLimitResponse(request, 'login')).toBeNull();

    recordFailures(request, 'login', AUTH_FAILURE_LIMIT - 1);
    expect(getEditorAuthRateLimitResponse(request, 'login')).toBeNull();

    recordEditorAuthFailure(request, 'login');
    expect(getEditorAuthRateLimitResponse(request, 'login')?.status).toBe(429);
  });
});

describe('Bucket bookkeeping', () => {
  it('bounds the failure map by evicting the oldest bucket at the cap', () => {
    const oldestClient = createRequest('198.51.0.0');

    recordFailures(oldestClient, 'login', AUTH_FAILURE_LIMIT);
    expect(getEditorAuthRateLimitResponse(oldestClient, 'login')?.status).toBe(429);

    for (let index = 0; index < 1_000; index += 1) {
      recordEditorAuthFailure(
        createRequest(`198.51.${Math.floor(index / 250) + 1}.${index % 250}`),
        'login'
      );
    }

    // The oldest bucket was evicted to keep the map bounded, while a client
    // recorded last still owns a working bucket.
    expect(getEditorAuthRateLimitResponse(oldestClient, 'login')).toBeNull();

    const newestClient = createRequest('203.0.113.200');

    recordFailures(newestClient, 'login', AUTH_FAILURE_LIMIT);

    expect(getEditorAuthRateLimitResponse(newestClient, 'login')?.status).toBe(429);
  });
});
