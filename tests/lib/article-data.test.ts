import { describe, expect, it } from 'vitest';
import {
  createArticleSlug,
  filterArticlesData,
  isArticle,
  parseArticlesData,
  parseArticlesDataOrThrow,
} from '@/lib/article-data';

const article = {
  id: 'article-1',
  title: 'Runtime Article',
  date: '2026-05-23',
  description: 'Shared article contract',
  tags: ['architecture'],
  content: '# Runtime Article',
  createdAt: 1,
  updatedAt: 2,
};

const normalizedDefaults = {
  kind: 'essay',
  status: 'published',
  featured: false,
  sourceLinks: [],
  revisionNotes: [],
};

describe('article data contract', () => {
  it('accepts valid article records', () => {
    expect(isArticle(article)).toBe(true);
    expect(parseArticlesData([article])).toEqual([
      {
        ...article,
        slug: createArticleSlug(article),
        ...normalizedDefaults,
      },
    ]);
  });

  it('rejects malformed records in strict parsing', () => {
    expect(isArticle({ ...article, tags: 'architecture' })).toBe(false);
    expect(parseArticlesData([article, { ...article, id: 1 }])).toBeNull();
    expect(parseArticlesData({ articles: [article] })).toBeNull();
    expect(() => parseArticlesDataOrThrow([article, { ...article, id: 1 }])).toThrow(
      '文章必须包含 id、title、date、description、tags、content、createdAt、updatedAt，且类型正确。'
    );
  });

  it('filters invalid records for local recovery paths', () => {
    expect(filterArticlesData([article, { ...article, updatedAt: '2' }, null])).toEqual([
      {
        ...article,
        slug: createArticleSlug(article),
        ...normalizedDefaults,
      },
    ]);
    expect(filterArticlesData(null)).toEqual([]);
  });

  it('normalizes stored slugs and rejects duplicates in strict parsing', () => {
    expect(parseArticlesData([{ ...article, slug: ' My Post! ' }])).toEqual([
      {
        ...article,
        slug: 'my-post',
        ...normalizedDefaults,
      },
    ]);
    expect(parseArticlesData([{ ...article, slug: '   ' }])).toEqual([
      {
        ...article,
        slug: createArticleSlug(article),
        ...normalizedDefaults,
      },
    ]);
    expect(parseArticlesData([
      { ...article, id: 'article-1', slug: 'same' },
      { ...article, id: 'article-2', slug: 'same' },
    ])).toBeNull();
    expect(() => parseArticlesDataOrThrow([
      { ...article, id: 'article-1', slug: 'same' },
      { ...article, id: 'article-2', slug: 'same' },
    ])).toThrow('文章 slug 重复：same');
  });

  it('normalizes optional metadata fields without breaking old records', () => {
    expect(parseArticlesData([{
      ...article,
      kind: 'guide',
      status: 'evergreen',
      category: ' 工程实践 ',
      featured: true,
      sourceLinks: [{ title: 'Docs', url: 'https://example.com', note: 'Reference' }],
      revisionNotes: [{ date: '2026-05-25', note: 'Updated examples' }],
    }])).toEqual([
      expect.objectContaining({
        kind: 'guide',
        status: 'evergreen',
        category: '工程实践',
        featured: true,
        sourceLinks: [{ title: 'Docs', url: 'https://example.com', note: 'Reference' }],
        revisionNotes: [{ date: '2026-05-25', note: 'Updated examples' }],
      }),
    ]);

    expect(parseArticlesData([{ ...article, kind: 'unknown', status: 'invalid' }])).toEqual([
      expect.objectContaining({
        kind: 'essay',
        status: 'published',
      }),
    ]);
  });

  it('drops unsafe article source links during parsing', () => {
    expect(parseArticlesData([{
      ...article,
      sourceLinks: [
        { title: 'Safe', url: ' https://example.com/reference ', note: ' Reference ' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<script>alert(1)</script>' },
        { title: 'Plain HTTP', url: 'http://example.com/reference' },
        { title: 'Missing URL', url: '   ' },
      ],
    }])).toEqual([
      expect.objectContaining({
        sourceLinks: [
          { title: 'Safe', url: 'https://example.com/reference', note: 'Reference' },
        ],
      }),
    ]);
  });
});
