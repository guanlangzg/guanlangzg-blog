import { parseDocument, stringify } from 'yaml';
import type { Frontmatter } from '@/app/types/article';
import { normalizeArticleKind, normalizeArticleStatus } from '@/lib/article-metadata';
import { normalizeSourceLinks, normalizeRevisionNotes } from '@/lib/source-links';

interface ParsedRawFrontmatterResult {
    content: string;
    data: Record<string, unknown>;
    hasFrontmatter: boolean;
}

interface ParsedFrontmatterResult {
    content: string;
    frontmatter: Partial<Frontmatter>;
    hasFrontmatter: boolean;
}

export const MAX_MARKDOWN_IMPORT_LENGTH = 1024 * 1024;
export const MAX_FRONTMATTER_IMPORT_LENGTH = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getFrontmatterBlockLength(markdown: string): number | null {
    const openMatch = /^---\r?\n/.exec(markdown);

    if (!openMatch) {
        return null;
    }

    const frontmatterStart = openMatch[0].length;
    const remaining = markdown.slice(frontmatterStart);
    const closeMatch = /\r?\n---(?:\r?\n|$)/.exec(remaining);

    return closeMatch ? closeMatch.index : remaining.length;
}

function assertMarkdownWithinImportLimit(markdown: string): void {
    if (markdown.length <= MAX_MARKDOWN_IMPORT_LENGTH) {
        const frontmatterLength = getFrontmatterBlockLength(markdown);

        if (frontmatterLength === null || frontmatterLength <= MAX_FRONTMATTER_IMPORT_LENGTH) {
            return;
        }

        throw new RangeError('Markdown frontmatter is too large.');
    }

    throw new RangeError('Markdown import is too large.');
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asDateString(value: unknown): string | undefined {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().split('T')[0];
    }

    return asString(value);
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeFrontmatterData(data: Record<string, unknown>): Partial<Frontmatter> {
    const frontmatter: Partial<Frontmatter> = {};
    const tags = asStringArray(data.tags);

    frontmatter.title = asString(data.title);
    frontmatter.slug = asString(data.slug);
    frontmatter.date = asDateString(data.date);
    frontmatter.updatedDate = asDateString(data.updatedDate);
    frontmatter.description = asString(data.description);
    frontmatter.category = asString(data.category);
    frontmatter.series = asString(data.series);
    frontmatter.featured = asBoolean(data.featured);
    frontmatter.templateId = asString(data.templateId);

    if (typeof data.kind === 'string') {
        frontmatter.kind = normalizeArticleKind(data.kind);
    }

    if (typeof data.status === 'string') {
        frontmatter.status = normalizeArticleStatus(data.status, 'draft');
    }

    if (tags) {
        frontmatter.tags = tags;
    }

    frontmatter.sourceLinks = normalizeSourceLinks(data.sourceLinks);
    frontmatter.revisionNotes = normalizeRevisionNotes(data.revisionNotes);

    return frontmatter;
}

function createOrderedFrontmatter(article: Frontmatter): Record<string, unknown> {
    return {
        title: article.title,
        ...(article.slug ? { slug: article.slug } : {}),
        date: article.date,
        ...(article.updatedDate ? { updatedDate: article.updatedDate } : {}),
        description: article.description,
        ...(article.kind ? { kind: article.kind } : {}),
        ...(article.status ? { status: article.status } : {}),
        ...(article.category ? { category: article.category } : {}),
        ...(article.series ? { series: article.series } : {}),
        ...(article.featured ? { featured: article.featured } : {}),
        tags: article.tags,
        ...(article.sourceLinks?.length ? { sourceLinks: article.sourceLinks } : {}),
        ...(article.revisionNotes?.length ? { revisionNotes: article.revisionNotes } : {}),
        ...(article.templateId ? { templateId: article.templateId } : {}),
    };
}

export function parseRawMarkdownFrontmatter(markdown: string): ParsedRawFrontmatterResult {
    const openMatch = /^---\r?\n/.exec(markdown);

    if (!openMatch) {
        return {
            content: markdown,
            data: {},
            hasFrontmatter: false,
        };
    }

    const frontmatterStart = openMatch[0].length;
    const remaining = markdown.slice(frontmatterStart);
    const closeMatch = /\r?\n---(?:\r?\n|$)/.exec(remaining);
    const frontmatterSource = closeMatch
        ? remaining.slice(0, closeMatch.index)
        : remaining;
    const content = closeMatch
        ? remaining.slice(closeMatch.index + closeMatch[0].length)
        : '';
    const document = parseDocument(frontmatterSource, {
        prettyErrors: false,
    });

    if (document.errors.length > 0) {
        throw document.errors[0];
    }

    const parsed = document.toJSON();

    return {
        content,
        data: isRecord(parsed) ? parsed : {},
        hasFrontmatter: true,
    };
}

export function stringifyRawMarkdownFrontmatter(content: string, data: Record<string, unknown>): string {
    const yaml = stringify(data, {
        lineWidth: 0,
    }).trimEnd();

    return `---\n${yaml}\n---\n\n${content}`.replace(/\n*$/, '\n');
}

export function parseMarkdownWithFrontmatter(markdown: string): ParsedFrontmatterResult {
    assertMarkdownWithinImportLimit(markdown);

    const parsed = parseRawMarkdownFrontmatter(markdown);

    return {
        content: parsed.content,
        frontmatter: normalizeFrontmatterData(parsed.data),
        hasFrontmatter: parsed.hasFrontmatter,
    };
}

export function serializeMarkdownWithFrontmatter(article: Frontmatter & { content: string }): string {
    const frontmatter = createOrderedFrontmatter(article);

    return stringifyRawMarkdownFrontmatter(article.content, frontmatter);
}
