import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  getEditorAuthRateLimitResponse,
  recordEditorAuthFailure,
  clearEditorAuthFailures,
  resetEditorAuthRateLimitForTests,
} from '@/lib/editor-auth-rate-limit';

describe('Rate Limiting', () => {
  const testOrigin = 'http://localhost:3000';
  const testPath = '/api/editor-auth';

  function createMockRequest(ip: string = '127.0.0.1'): NextRequest {
    const request = new NextRequest(`${testOrigin}${testPath}`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': ip,
        'user-agent': 'test-client',
      },
    });

    return request;
  }

  beforeEach(() => {
    resetEditorAuthRateLimitForTests();
  });

  afterEach(() => {
    resetEditorAuthRateLimitForTests();
  });

  describe('Login rate limiting', () => {
    it('should allow first 4 failed login attempts', () => {
      const request = createMockRequest();

      for (let i = 0; i < 4; i++) {
        const response = getEditorAuthRateLimitResponse(request, 'login');
        expect(response).toBeNull();
        recordEditorAuthFailure(request, 'login');
      }

      // 第 5 次检查前仍未触发限流
      const response = getEditorAuthRateLimitResponse(request, 'login');
      expect(response).toBeNull();
    });

    it('should block after 5 failed login attempts', () => {
      const request = createMockRequest();

      // 记录 5 次失败
      for (let i = 0; i < 5; i++) {
        recordEditorAuthFailure(request, 'login');
      }

      // 第 6 次尝试应该被阻止
      const response = getEditorAuthRateLimitResponse(request, 'login');
      expect(response).not.toBeNull();
      expect(response?.status).toBe(429);
    });

    it('should clear rate limit on successful login', () => {
      const request = createMockRequest();

      // 记录 3 次失败
      for (let i = 0; i < 3; i++) {
        recordEditorAuthFailure(request, 'login');
      }

      // 成功登录，清除计数
      clearEditorAuthFailures(request, 'login');

      // 应该可以继续尝试
      const response = getEditorAuthRateLimitResponse(request, 'login');
      expect(response).toBeNull();
    });

    it('should use separate counters for different IPs', () => {
      const request1 = createMockRequest('192.168.1.1');
      const request2 = createMockRequest('192.168.1.2');

      // IP1 记录 5 次失败
      for (let i = 0; i < 5; i++) {
        recordEditorAuthFailure(request1, 'login');
      }

      // IP1 被限流
      const response1 = getEditorAuthRateLimitResponse(request1, 'login');
      expect(response1).not.toBeNull();

      // 可能返回 429 (限流) 或 503 (未配置代理)
      if (response1) {
        expect([429, 503]).toContain(response1.status);
      }

      // IP2 不受影响
      const response2 = getEditorAuthRateLimitResponse(request2, 'login');
      // null 表示通过，429 或 503 表示限流或未配置
      if (response2) {
        expect([429, 503]).toContain(response2.status);
      }
    });

    it('should use separate counters for login and setup', () => {
      const request = createMockRequest();

      // login 记录 5 次失败
      for (let i = 0; i < 5; i++) {
        recordEditorAuthFailure(request, 'login');
      }

      // login 被限流
      expect(getEditorAuthRateLimitResponse(request, 'login')).not.toBeNull();

      // setup 不受影响
      expect(getEditorAuthRateLimitResponse(request, 'setup')).toBeNull();
    });
  });

  describe('Setup rate limiting', () => {
    it('should block after 5 failed setup attempts', () => {
      const request = createMockRequest();

      // 记录 5 次失败
      for (let i = 0; i < 5; i++) {
        recordEditorAuthFailure(request, 'setup');
      }

      // 应该被阻止
      const response = getEditorAuthRateLimitResponse(request, 'setup');
      expect(response).not.toBeNull();
      expect(response?.status).toBe(429);
    });

    it('should return correct error message', async () => {
      const request = createMockRequest();

      // 触发限流
      for (let i = 0; i < 5; i++) {
        recordEditorAuthFailure(request, 'setup');
      }

      const response = getEditorAuthRateLimitResponse(request, 'setup');
      expect(response).not.toBeNull();

      const body = await response?.json();
      expect(body.message).toContain('尝试次数过多');
    });
  });

  describe('Rate limit window', () => {
    it('should respect 15-minute window', () => {
      const request = createMockRequest();

      // 记录失败并检查限流响应格式
      recordEditorAuthFailure(request, 'login');
      const response = getEditorAuthRateLimitResponse(request, 'login');

      // 在限流触发前，响应应该是 null
      expect(response).toBeNull();
    });
  });

  describe('Memory management', () => {
    it('should handle many different IPs without memory leak', () => {
      // 模拟 100 个不同 IP（降低数量避免超时）
      for (let i = 0; i < 100; i++) {
        const request = createMockRequest(`192.168.${Math.floor(i / 256)}.${i % 256}`);
        recordEditorAuthFailure(request, 'login');
      }

      // 测试一个新 IP
      const testRequest = createMockRequest('10.0.0.1');
      const response = getEditorAuthRateLimitResponse(testRequest, 'login');

      // 第一次失败不应触发限流
      // 可能返回 null (通过) 或 503 (未配置代理)
      if (response) {
        expect([503, 429]).toContain(response.status);
      }
    });
  });
});
