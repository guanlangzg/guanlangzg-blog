import { describe, expect, it } from 'vitest';
import {
  ARTICLE_KIND_OPTIONS,
  ARTICLE_STATUS_OPTIONS,
  QUALITY_SEVERITY_LABELS,
  TEMPLATE_GROUP_OPTIONS,
  getArticleKindLabel,
  getArticleStatusLabel,
  isPublicArticleStatus,
  normalizeArticleKind,
  normalizeArticleStatus,
} from '@/lib/article-metadata';

describe('article metadata options', () => {
  it('exposes a non-empty kind list with unique values', () => {
    expect(ARTICLE_KIND_OPTIONS.length).toBeGreaterThan(0);
    expect(new Set(ARTICLE_KIND_OPTIONS.map((option) => option.value)).size).toBe(
      ARTICLE_KIND_OPTIONS.length
    );
    ARTICLE_KIND_OPTIONS.forEach((option) => {
      expect(option.label.trim()).toBeTruthy();
    });
  });

  it('exposes a non-empty status list with unique values', () => {
    expect(ARTICLE_STATUS_OPTIONS.length).toBeGreaterThan(0);
    expect(new Set(ARTICLE_STATUS_OPTIONS.map((option) => option.value)).size).toBe(
      ARTICLE_STATUS_OPTIONS.length
    );
  });

  it('labels every quality severity', () => {
    expect(QUALITY_SEVERITY_LABELS.blocking).toBe('阻塞');
    expect(QUALITY_SEVERITY_LABELS.warning).toBe('建议');
    expect(QUALITY_SEVERITY_LABELS.suggestion).toBe('提示');
  });

  it('exposes template group options', () => {
    expect(TEMPLATE_GROUP_OPTIONS.map((option) => option.value)).toEqual([
      'quick',
      'deep',
      'review',
      'entry',
    ]);
  });
});

describe('normalizeArticleKind', () => {
  it('accepts known kinds and falls back for unknown values', () => {
    expect(normalizeArticleKind('guide')).toBe('guide');
    expect(normalizeArticleKind('til')).toBe('til');
    expect(normalizeArticleKind('mystery-kind')).toBe('essay');
    expect(normalizeArticleKind(42)).toBe('essay');
    expect(normalizeArticleKind(null)).toBe('essay');
    expect(normalizeArticleKind(undefined)).toBe('essay');
  });

  it('honors a custom fallback', () => {
    expect(normalizeArticleKind('nope', 'project')).toBe('project');
  });
});

describe('normalizeArticleStatus', () => {
  it('accepts known statuses and falls back for unknown values', () => {
    expect(normalizeArticleStatus('draft')).toBe('draft');
    expect(normalizeArticleStatus('evergreen')).toBe('evergreen');
    expect(normalizeArticleStatus('unknown')).toBe('published');
    expect(normalizeArticleStatus(undefined)).toBe('published');
  });

  it('honors a custom fallback', () => {
    expect(normalizeArticleStatus('nope', 'archived')).toBe('archived');
  });
});

describe('article metadata labels', () => {
  it('returns labels for known kinds and statuses', () => {
    expect(getArticleKindLabel('deep-dive')).toBe('研究长文');
    expect(getArticleStatusLabel('seedling')).toBe('幼苗');
  });

  it('falls back to a default label for unknown values', () => {
    expect(getArticleKindLabel()).toBe('观点随笔');
    expect(getArticleStatusLabel()).toBe('已发布');
  });
});

describe('isPublicArticleStatus', () => {
  it('treats every status except draft as public', () => {
    expect(isPublicArticleStatus('published')).toBe(true);
    expect(isPublicArticleStatus('evergreen')).toBe(true);
    expect(isPublicArticleStatus('archived')).toBe(true);
    expect(isPublicArticleStatus('seedling')).toBe(true);
    expect(isPublicArticleStatus('draft')).toBe(false);
    expect(isPublicArticleStatus(undefined)).toBe(true);
  });
});
