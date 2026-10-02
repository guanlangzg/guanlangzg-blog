import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, normalizeSafeExternalUrl } from '@/lib/url-safety';

describe('isSafeExternalUrl', () => {
  it('accepts HTTPS URLs in every environment', () => {
    expect(isSafeExternalUrl('https://example.com/path')).toBe(true);
    expect(isSafeExternalUrl('  https://example.com  ')).toBe(true);
  });

  it('accepts local HTTP hosts outside production only', () => {
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isSafeExternalUrl('http://[::1]:3000')).toBe(true);
  });

  it('rejects plain HTTP to remote hosts', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('http://192.168.1.1')).toBe(false);
  });

  it('rejects non-URL or unsupported protocols', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('ftp://example.com/file')).toBe(false);
  });
});

describe('normalizeSafeExternalUrl', () => {
  it('returns the trimmed URL for safe values', () => {
    expect(normalizeSafeExternalUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('returns null for unsafe, empty or non-string values', () => {
    expect(normalizeSafeExternalUrl('http://example.com')).toBeNull();
    expect(normalizeSafeExternalUrl('')).toBeNull();
    expect(normalizeSafeExternalUrl('   ')).toBeNull();
    expect(normalizeSafeExternalUrl(42)).toBeNull();
    expect(normalizeSafeExternalUrl(null)).toBeNull();
    expect(normalizeSafeExternalUrl(undefined)).toBeNull();
  });
});
