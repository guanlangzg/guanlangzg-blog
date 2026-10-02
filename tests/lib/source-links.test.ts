import { describe, expect, it } from 'vitest';
import { normalizeRevisionNotes, normalizeSourceLinks } from '@/lib/source-links';

describe('normalizeSourceLinks', () => {
  it('normalizes valid source links and trims whitespace', () => {
    expect(normalizeSourceLinks([
      {
        title: '  MDN  ',
        url: '  https://developer.mozilla.org  ',
        note: ' 权威文档  ',
      },
    ])).toEqual([
      {
        title: 'MDN',
        url: 'https://developer.mozilla.org',
        note: '权威文档',
      },
    ]);
  });

  it('omits the note when it is empty', () => {
    expect(normalizeSourceLinks([
      {
        title: 'Docs',
        url: 'https://docs.example.com',
        note: '   ',
      },
    ])).toEqual([
      {
        title: 'Docs',
        url: 'https://docs.example.com',
      },
    ]);
  });

  it('drops entries with missing titles or unsafe URLs', () => {
    expect(normalizeSourceLinks([
      { title: '', url: 'https://example.com' },
      { title: 'Plain HTTP', url: 'http://example.com' },
      { title: 'Missing URL' },
      { url: 'https://example.com' },
      42,
      null,
    ])).toEqual([]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeSourceLinks(undefined)).toEqual([]);
    expect(normalizeSourceLinks('links')).toEqual([]);
  });
});

describe('normalizeRevisionNotes', () => {
  it('normalizes valid revision notes', () => {
    expect(normalizeRevisionNotes([
      { date: ' 2026-06-01 ', note: ' 修正拼写 ' },
    ])).toEqual([
      { date: '2026-06-01', note: '修正拼写' },
    ]);
  });

  it('drops entries with missing date or note', () => {
    expect(normalizeRevisionNotes([
      { date: '', note: '内容' },
      { date: '2026-06-01', note: '  ' },
      { note: '只有说明' },
      { date: '2026-06-01' },
      'invalid',
    ])).toEqual([]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeRevisionNotes(null)).toEqual([]);
  });
});
