import type { Article } from '@/app/types/article';
import { normalizeArticleKind, normalizeArticleStatus } from '@/lib/article-metadata';
import { normalizeSourceLinks, normalizeRevisionNotes } from '@/lib/source-links';
import { normalizeOptionalString } from '@/lib/utils';

export class ArticleDataParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArticleDataParseError';
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function normalizeSlugPart(value: string): string {
    return value
        .trim()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function normalizeIdSuffix(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(-6) || 'entry';
}

export function createArticleSlug(article: Pick<Article, 'id' | 'title'>): string {
    const base = normalizeSlugPart(article.title) || 'article';
    return `${base}-${normalizeIdSuffix(article.id)}`;
}

export function normalizeStoredSlug(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const slug = normalizeSlugPart(value);
    return slug.length > 0 ? slug : null;
}

export function isArticle(value: unknown): value is Article {
    if (!isRecord(value)) {
        return false;
    }

    return (
        typeof value.id === 'string' &&
        typeof value.title === 'string' &&
        typeof value.date === 'string' &&
        typeof value.description === 'string' &&
        isStringArray(value.tags) &&
        typeof value.content === 'string' &&
        isFiniteNumber(value.createdAt) &&
        isFiniteNumber(value.updatedAt) &&
        isOptionalString(value.slug) &&
        isOptionalString(value.kind) &&
        isOptionalString(value.status) &&
        isOptionalString(value.category) &&
        isOptionalString(value.series) &&
        isOptionalString(value.updatedDate) &&
        isOptionalString(value.templateId) &&
        (value.featured === undefined || typeof value.featured === 'boolean') &&
        (value.sourceLinks === undefined || Array.isArray(value.sourceLinks)) &&
        (value.revisionNotes === undefined || Array.isArray(value.revisionNotes))
    );
}

function normalizeArticleOrThrow(value: unknown): Article {
    if (!isArticle(value)) {
        throw new ArticleDataParseError(
            '文章必须包含 id、title、date、description、tags、content、createdAt、updatedAt，且类型正确。'
        );
    }

    return {
        id: value.id,
        title: value.title,
        date: value.date,
        description: value.description,
        tags: value.tags,
        content: value.content,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        slug: normalizeStoredSlug(value.slug) ?? createArticleSlug(value),
        kind: normalizeArticleKind(value.kind),
        status: normalizeArticleStatus(value.status),
        featured: normalizeOptionalBoolean(value.featured) ?? false,
        sourceLinks: normalizeSourceLinks(value.sourceLinks),
        revisionNotes: normalizeRevisionNotes(value.revisionNotes),
        ...(normalizeOptionalString(value.category) ? { category: normalizeOptionalString(value.category) } : {}),
        ...(normalizeOptionalString(value.series) ? { series: normalizeOptionalString(value.series) } : {}),
        ...(normalizeOptionalString(value.updatedDate) ? { updatedDate: normalizeOptionalString(value.updatedDate) } : {}),
        ...(normalizeOptionalString(value.templateId) ? { templateId: normalizeOptionalString(value.templateId) } : {}),
    };
}

function normalizeArticle(value: unknown): Article | null {
    try {
        return normalizeArticleOrThrow(value);
    } catch {
        return null;
    }
}

export function filterArticlesData(value: unknown): Article[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const slugs = new Set<string>();
    const articles: Article[] = [];

    for (const item of value) {
        const article = normalizeArticle(item);

        if (!article?.slug || slugs.has(article.slug)) {
            continue;
        }

        slugs.add(article.slug);
        articles.push(article);
    }

    return articles;
}

export function parseArticleDataOrThrow(value: unknown): Article {
    return normalizeArticleOrThrow(value);
}

export function parseArticlesDataOrThrow(value: unknown): Article[] {
    if (!Array.isArray(value)) {
        throw new ArticleDataParseError('文章数据必须是数组。');
    }

    const slugs = new Set<string>();
    const articles = value.map((item) => normalizeArticleOrThrow(item));

    for (const article of articles) {
        if (!article.slug) {
            throw new ArticleDataParseError(`文章 slug 无效：${article.id}`);
        }

        if (slugs.has(article.slug)) {
            throw new ArticleDataParseError(`文章 slug 重复：${article.slug}`);
        }

        slugs.add(article.slug);
    }

    return articles;
}

/** Write-path guard: reading articles.json throws on duplicate slugs, so every writer must reject them too. */
export function assertUniqueArticleSlugs(articles: Article[]): void {
    const slugs = new Set<string>();

    for (const article of articles) {
        if (!article.slug) {
            throw new ArticleDataParseError(`文章 slug 无效：${article.id}`);
        }

        if (slugs.has(article.slug)) {
            throw new ArticleDataParseError(`文章 slug 重复：${article.slug}`);
        }

        slugs.add(article.slug);
    }
}

export function parseArticlesData(value: unknown): Article[] | null {
    try {
        return parseArticlesDataOrThrow(value);
    } catch {
        return null;
    }
}
