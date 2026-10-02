import { describe, expect, it } from 'vitest';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  isSearchQueryAllowed,
  normalizeSearchQuery,
} from '@/lib/search-query';

describe('normalizeSearchQuery', () => {
  it('trims, collapses whitespace and lowercases the query', () => {
    expect(normalizeSearchQuery('  React  Hooks  ')).toBe('react hooks');
    expect(normalizeSearchQuery(null)).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
    expect(normalizeSearchQuery('')).toBe('');
  });

  it('truncates the query to the configured maximum length', () => {
    const longQuery = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 50);

    expect(normalizeSearchQuery(longQuery).length).toBe(SEARCH_QUERY_MAX_LENGTH);
  });
});

describe('isSearchQueryAllowed', () => {
  it('requires at least the minimum query length', () => {
    expect(isSearchQueryAllowed('a'.repeat(SEARCH_QUERY_MIN_LENGTH))).toBe(true);
    expect(isSearchQueryAllowed('ab')).toBe(true);
    expect(isSearchQueryAllowed('a')).toBe(false);
    expect(isSearchQueryAllowed('')).toBe(false);
  });
});
