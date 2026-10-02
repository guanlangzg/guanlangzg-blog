import { describe, expect, it } from 'vitest';
import {
  MAX_FRONTMATTER_IMPORT_LENGTH,
  MAX_MARKDOWN_IMPORT_LENGTH,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
} from '@/lib/frontmatter';

describe('frontmatter parser', () => {
  it('parses old frontmatter shape', () => {
    const parsed = parseMarkdownWithFrontmatter(`---
title: "Old Post"
date: "2026-05-25"
description: "Old summary"
tags: ["next", "blog"]
---
# Body`);

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual(expect.objectContaining({
      title: 'Old Post',
      date: '2026-05-25',
      description: 'Old summary',
      tags: ['next', 'blog'],
    }));
    expect(parsed.content).toBe('# Body');
  });

  it('parses nested source links and revision notes', () => {
    const parsed = parseMarkdownWithFrontmatter(`---
title: Research
date: "2026-05-25"
description: Research summary
kind: deep-dive
status: evergreen
category: 架构设计
featured: true
tags:
  - research
sourceLinks:
  - title: Docs
    url: https://example.com
    note: Primary source
revisionNotes:
  - date: "2026-05-25"
    note: First publish
---
Body`);

    expect(parsed.frontmatter).toEqual(expect.objectContaining({
      kind: 'deep-dive',
      status: 'evergreen',
      category: '架构设计',
      featured: true,
      tags: ['research'],
      sourceLinks: [{ title: 'Docs', url: 'https://example.com', note: 'Primary source' }],
      revisionNotes: [{ date: '2026-05-25', note: 'First publish' }],
    }));
  });

  it('filters unsafe source links from imported frontmatter', () => {
    const parsed = parseMarkdownWithFrontmatter(`---
title: Research
date: "2026-05-25"
description: Research summary
tags: []
sourceLinks:
  - title: Safe
    url: https://example.com/reference
  - title: Script
    url: javascript:alert(1)
  - title: Data
    url: data:text/html,<script>alert(1)</script>
  - title: Plain HTTP
    url: http://example.com/reference
---
Body`);

    expect(parsed.frontmatter.sourceLinks).toEqual([
      { title: 'Safe', url: 'https://example.com/reference' },
    ]);
  });

  it('keeps YAML timestamp dates as yyyy-mm-dd strings', () => {
    const parsed = parseMarkdownWithFrontmatter(`---
title: Date Post
date: 2026-05-25
updatedDate: 2026-05-26
description: Date summary
tags: []
---
Body`);

    expect(parsed.frontmatter.date).toBe('2026-05-25');
    expect(parsed.frontmatter.updatedDate).toBe('2026-05-26');
  });

  it('rejects oversized markdown imports before parsing frontmatter', () => {
    expect(() => parseMarkdownWithFrontmatter('x'.repeat(MAX_MARKDOWN_IMPORT_LENGTH + 1))).toThrow(
      'Markdown import is too large.'
    );
  });

  it('rejects oversized frontmatter blocks before parsing YAML', () => {
    const markdown = `---\n${'alias: value\n'.repeat(Math.ceil(MAX_FRONTMATTER_IMPORT_LENGTH / 13) + 1)}---\nBody`;

    expect(() => parseMarkdownWithFrontmatter(markdown)).toThrow('Markdown frontmatter is too large.');
  });

  it('serializes fields in a stable order', () => {
    const markdown = serializeMarkdownWithFrontmatter({
      title: 'Stable Export',
      slug: 'stable-export',
      date: '2026-05-25',
      updatedDate: '2026-05-26',
      description: 'Export summary',
      kind: 'guide',
      status: 'published',
      category: '工程实践',
      featured: false,
      tags: ['export'],
      content: '# Stable Export',
    });

    expect(markdown.indexOf('title: Stable Export')).toBeLessThan(markdown.indexOf('slug: stable-export'));
    expect(markdown.indexOf('slug: stable-export')).toBeLessThan(markdown.indexOf('date:'));
    expect(markdown).toContain('kind: guide');
    expect(markdown).toContain('status: published');
    expect(markdown).toContain('# Stable Export');
  });
});
