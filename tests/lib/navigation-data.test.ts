import { describe, expect, it } from 'vitest';
import { isValidNavigationUrl, parseNavigationData, parseNavigationDataOrThrow } from '@/lib/navigation-data';

const validCategory = {
  name: '开发文档',
  icon: 'blog',
  slug: 'developer-docs',
  tools: [
    {
      icon: 'blog',
      title: 'MDN Web Docs',
      description: 'Web 平台权威文档，覆盖 HTML、CSS、JavaScript 和浏览器 API',
      url: 'https://developer.mozilla.org',
      tags: ['文档', 'Web'],
    },
  ],
};

describe('navigation data parser', () => {
  it('accepts valid navigation data and normalizes whitespace', () => {
    const parsed = parseNavigationData([
      {
        ...validCategory,
        name: ' 开发文档 ',
        slug: ' Developer Docs ',
      },
    ]);

    expect(parsed).toEqual([
      expect.objectContaining({
        name: '开发文档',
        slug: 'developer-docs',
      }),
    ]);
  });

  it('allows draft categories without tools', () => {
    expect(
      parseNavigationData([
        {
          name: '稍后整理',
          icon: 'folder',
          slug: 'draft-links',
          tools: [],
        },
      ])
    ).toEqual([
      expect.objectContaining({
        slug: 'draft-links',
        tools: [],
      }),
    ]);
  });

  it('rejects invalid tool contracts', () => {
    expect(
      parseNavigationData([
        {
          ...validCategory,
          tools: [
            {
              ...validCategory.tools[0],
              url: 'http://developer.mozilla.org',
            },
          ],
        },
      ])
    ).toBeNull();
    expect(() => parseNavigationDataOrThrow([
      {
        ...validCategory,
        tools: [
          {
            ...validCategory.tools[0],
            url: 'http://developer.mozilla.org',
          },
        ],
      },
    ])).toThrow('导航工具必须包含 icon、title、description 和 HTTPS URL。');

    expect(
      parseNavigationData([
        {
          ...validCategory,
          tools: [
            {
              ...validCategory.tools[0],
              tags: [],
            },
          ],
        },
      ])
    ).toBeNull();
  });

  it('rejects duplicate category slugs', () => {
    expect(parseNavigationData([validCategory, validCategory])).toBeNull();
    expect(() => parseNavigationDataOrThrow([validCategory, validCategory])).toThrow(
      '导航分类 slug 重复：developer-docs'
    );
  });
});

describe('navigation URL validation', () => {
  it('requires HTTPS URLs', () => {
    expect(isValidNavigationUrl('https://github.com')).toBe(true);
    expect(isValidNavigationUrl('http://github.com')).toBe(false);
    expect(isValidNavigationUrl('github.com')).toBe(false);
  });
});
