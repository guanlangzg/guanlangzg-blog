import type { Frontmatter } from '@/app/types/article';
import { normalizeRevisionNotes, normalizeSourceLinks } from '@/lib/source-links';

export function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function createArticleSnapshot(frontmatter: Frontmatter, content: string): string {
  return JSON.stringify({ frontmatter, content });
}

export function normalizeFrontmatter(frontmatter: Frontmatter): Frontmatter {
  return {
    title: frontmatter.title.trim(),
    slug: frontmatter.slug?.trim(),
    date: frontmatter.date || getTodayString(),
    updatedDate: frontmatter.updatedDate || undefined,
    description: frontmatter.description.trim(),
    kind: frontmatter.kind || 'essay',
    status: frontmatter.status || 'draft',
    category: frontmatter.category?.trim(),
    series: frontmatter.series?.trim(),
    featured: Boolean(frontmatter.featured),
    tags: frontmatter.tags.map((tag) => tag.trim()).filter(Boolean),
    sourceLinks: normalizeSourceLinks(frontmatter.sourceLinks),
    revisionNotes: normalizeRevisionNotes(frontmatter.revisionNotes),
    templateId: frontmatter.templateId,
  };
}
