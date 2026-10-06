import { describe, expect, it } from 'vitest';
import {
  getFrontmatterFieldQualityChecks,
  getArticleQualityChecks,
  getArticleSaveBlockingChecks,
  getMarkdownHeadings,
  hasRequiredSection,
  isFirstMarkdownH1DuplicateTitle,
} from '@/lib/article-quality';
import { getTemplateById } from '@/lib/templates';

describe('article quality checks', () => {
  it('marks missing titles as blocking', () => {
    const checks = getArticleQualityChecks({
      title: '',
      date: '2026-05-25',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'draft',
    });

    expect(checks).toContainEqual(expect.objectContaining({
      id: 'title-required',
      severity: 'blocking',
      passed: false,
    }));
  });

  it('warns when tutorial required sections are missing', () => {
    const checks = getArticleQualityChecks({
      title: 'Guide',
      date: '2026-05-25',
      description: '这是一段足够长的描述，用来说明读者为什么要阅读这篇教程。',
      tags: ['guide'],
      content: '## 背景\n\nOnly background.',
      kind: 'guide',
      status: 'published',
      category: '工程实践',
    }, getTemplateById('tutorial'));

    expect(checks).toContainEqual(expect.objectContaining({
      id: 'required-section-验证',
      severity: 'warning',
      passed: false,
    }));
  });

  it('detects section aliases and untyped code blocks', () => {
    const headings = getMarkdownHeadings('## References\n\n```\\ncode\\n```');
    const checks = getArticleQualityChecks({
      title: 'Research',
      date: '2026-05-25',
      description: '这是一段足够长的研究说明，用来解释结论来源和适用边界。',
      tags: ['research'],
      content: '## References\n\n```\\ncode\\n```',
      kind: 'deep-dive',
      status: 'published',
      category: '架构设计',
    });

    expect(hasRequiredSection(headings, '参考资料')).toBe(true);
    expect(checks).toContainEqual(expect.objectContaining({
      id: 'code-language',
      severity: 'suggestion',
      passed: false,
    }));
  });

  it('creates heading ids from rendered markdown heading text', () => {
    const headings = getMarkdownHeadings('## [MDN Docs](https://developer.mozilla.org) and `fetch`');

    expect(headings[0]).toEqual(expect.objectContaining({
      text: '[MDN Docs](https://developer.mozilla.org) and `fetch`',
      id: 'MDN%20Docs%20and%20fetch',
    }));
  });

  it('ignores heading-like lines inside fenced and indented code blocks', () => {
    const content = '```bash\n# 安装依赖\nnpm install\n```\n\n    # indented code\n\n## Real Section';
    const headings = getMarkdownHeadings(content);

    expect(headings.map((heading) => `${heading.level}:${heading.text}`)).toEqual(['2:Real Section']);
    expect(headings[0]?.id).toBe('Real%20Section');
    // The anchor offset must be the line start used by MarkdownContent for id lookup.
    expect(headings[0]?.index).toBe(content.indexOf('## Real Section'));
  });

  it('parses setext headings like the markdown renderer', () => {
    const headings = getMarkdownHeadings('Setext Title\n=====\n\nSub Section\n-----');

    expect(headings.map((heading) => `${heading.level}:${heading.text}:${heading.id}`)).toEqual([
      '1:Setext Title:Setext%20Title',
      '2:Sub Section:Sub%20Section',
    ]);
    expect(isFirstMarkdownH1DuplicateTitle('Setext Title\n=====\n\nSub Section', 'Setext Title')).toBe(true);
  });

  it('anchors the duplicate-title check on the rendered first heading', () => {
    const content = '```bash\n# 安装依赖\n```\n\n# 安装依赖\n\n## S';
    const headings = getMarkdownHeadings(content);

    expect(headings.map((heading) => heading.level)).toEqual([1, 2]);
    expect(headings[0]?.index).toBe(content.lastIndexOf('# 安装依赖'));
    expect(isFirstMarkdownH1DuplicateTitle(content, '安装依赖')).toBe(true);
  });

  it('does not count fenced code lines as sections or extra H1s', () => {
    const checks = getArticleQualityChecks({
      title: 'Notes',
      date: '2026-05-25',
      description: '这是一段足够长的说明，用来验证围栏代码块不会影响章节与标题计数。',
      tags: ['notes'],
      content: '```bash\n# 步骤一\n# 步骤二\n```\n\n## 正文',
      kind: 'deep-dive',
      status: 'published',
      category: '工程实践',
    });

    expect(checks).toContainEqual(expect.objectContaining({ id: 'h1-limit', passed: true }));
    expect(hasRequiredSection(getMarkdownHeadings('```bash\n## 参考资料\necho hi\n```'), '参考资料')).toBe(false);
  });

  it('keeps duplicate heading ids unique and stable', () => {
    const headings = getMarkdownHeadings([
      '## Review',
      '### Review',
      '## Review',
      '## ',
    ].join('\n'));

    expect(headings.map((heading) => heading.id)).toEqual([
      'Review',
      'Review-2',
      'Review-3',
    ]);
  });

  it('detects only the first matching markdown h1 as a duplicate page title', () => {
    expect(isFirstMarkdownH1DuplicateTitle('\n# Title\n\n## Section', 'Title')).toBe(true);
    expect(isFirstMarkdownH1DuplicateTitle('## Section\n\n# Title', 'Title')).toBe(false);
    expect(isFirstMarkdownH1DuplicateTitle('# Other', 'Title')).toBe(false);
  });

  it('allows incomplete drafts to be saved while keeping public blocking checks', () => {
    const draftChecks = getArticleSaveBlockingChecks({
      title: '',
      date: '2026-05-25',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'draft',
      featured: true,
    });
    const publicChecks = getArticleSaveBlockingChecks({
      title: '',
      date: '2026-05-25',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'published',
    });

    expect(draftChecks).toEqual([]);
    expect(publicChecks.map((check) => check.id)).toContain('title-required');
    expect(publicChecks.map((check) => check.id)).toContain('published-description');
  });

  it('requires descriptions for every public article status', () => {
    for (const status of ['seedling', 'published', 'evergreen', 'archived'] as const) {
      expect(getArticleQualityChecks({
        title: 'Public article',
        date: '2026-05-25',
        description: '',
        tags: ['public'],
        content: '# Public',
        status,
      })).toContainEqual(expect.objectContaining({
        id: 'published-description',
        passed: false,
      }));
    }
  });

  it('keeps invalid dates as blocking for draft saves', () => {
    expect(getArticleSaveBlockingChecks({
      title: '',
      date: '',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'draft',
    })).toContainEqual(expect.objectContaining({
      id: 'date-valid',
      passed: false,
    }));
  });

  it('blocks unsafe source URLs before saving drafts or published articles', () => {
    const draftChecks = getArticleSaveBlockingChecks({
      title: '',
      date: '2026-05-25',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'draft',
      sourceLinks: [{ title: 'Unsafe Docs', url: 'javascript:alert(1)' }],
    });
    const publicChecks = getArticleSaveBlockingChecks({
      title: 'Public article',
      date: '2026-05-25',
      description: '这是一段足够长的描述，用来验证参考资料链接安全检查。',
      tags: ['public'],
      content: '# Public',
      status: 'published',
      sourceLinks: [{ title: 'Unsafe Docs', url: 'javascript:alert(1)' }],
    });

    expect(draftChecks).toContainEqual(expect.objectContaining({
      id: 'source-url-valid',
      severity: 'blocking',
      passed: false,
    }));
    expect(publicChecks).toContainEqual(expect.objectContaining({
      id: 'source-url-valid',
      severity: 'blocking',
      passed: false,
    }));
  });

  it('maps failed publishing checks back to editable frontmatter fields', () => {
    const publishedFieldChecks = getFrontmatterFieldQualityChecks(getArticleQualityChecks({
      title: '',
      date: 'not-a-date',
      updatedDate: '',
      description: '',
      tags: [],
      content: '# Draft',
      status: 'published',
      featured: true,
      sourceLinks: [{ title: 'Unsafe Docs', url: 'javascript:alert(1)' }],
    }));
    const evergreenFieldChecks = getFrontmatterFieldQualityChecks(getArticleQualityChecks({
      title: 'Evergreen',
      date: '2026-05-25',
      updatedDate: '',
      description: '这是一段足够长的描述，用来验证常青文章修订日期提示。',
      tags: ['evergreen'],
      content: '# Evergreen',
      status: 'evergreen',
    }));

    expect(publishedFieldChecks.title?.map((check) => check.id)).toContain('title-required');
    expect(publishedFieldChecks.date?.map((check) => check.id)).toContain('date-valid');
    expect(publishedFieldChecks.description?.map((check) => check.id)).toContain('published-description');
    expect(publishedFieldChecks.tags?.map((check) => check.id)).toContain('tags-present');
    expect(publishedFieldChecks.sourceLinks?.map((check) => check.id)).toContain('source-url-valid');
    expect(evergreenFieldChecks.updatedDate?.map((check) => check.id)).toContain('evergreen-updated-date');
  });
});
