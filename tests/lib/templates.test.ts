import { describe, expect, it } from 'vitest';
import { getDefaultTemplate, articleTemplates } from '@/lib/templates';
import { getMarkdownHeadings, hasRequiredSection } from '@/lib/article-quality';

describe('article templates', () => {
  it('keeps template ids unique and blank as the default', () => {
    const ids = articleTemplates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(getDefaultTemplate().id).toBe('blank');
  });

  it('defines metadata for every template', () => {
    for (const template of articleTemplates) {
      expect(template.group).toBeTruthy();
      expect(template.kind).toBeTruthy();
      expect(template.defaultStatus).toBeTruthy();
      expect(template.frontmatter.kind).toBe(template.kind);
      expect(template.frontmatter.status).toBe(template.defaultStatus);
    }
  });

  it('keeps required sections aligned with template content', () => {
    for (const template of articleTemplates) {
      const headings = getMarkdownHeadings(template.content);

      for (const section of template.requiredSections || []) {
        expect(hasRequiredSection(headings, section), `${template.id} missing ${section}`).toBe(true);
      }
    }
  });
});
