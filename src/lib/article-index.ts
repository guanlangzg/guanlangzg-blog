import type { Article, ArticleKind, ArticleRevisionNote, ArticleSourceLink, ArticleStatus } from '@/app/types/article';
import { normalizeArticleKind, normalizeArticleStatus } from '@/lib/article-metadata';
import { countMarkdownWords } from '@/lib/article-quality';
import { normalizeOptionalString } from '@/lib/utils';
import { normalizeSourceLinks, normalizeRevisionNotes } from '@/lib/source-links';

export const ARTICLE_INDEX_VERSION = 1;

export interface ArticleIndexEntry {
    slug: string;
    slugArray: string[];
    title: string;
    date: string;
    description?: string;
    updatedDate?: string;
    tags: string[];
    kind: ArticleKind;
    status: ArticleStatus;
    category?: string;
    series?: string;
    featured: boolean;
    readingMinutes: number;
    sourceLinks: ArticleSourceLink[];
    revisionNotes: ArticleRevisionNote[];
}

export interface ArticleIndexFile {
    version: typeof ARTICLE_INDEX_VERSION;
    sourceUpdatedAt: string;
    articles: ArticleIndexEntry[];
}

function normalizeDate(value: unknown): string {
    if (!value) return '';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
}

export function createArticleIndex(articles: Article[], sourceUpdatedAt: string): ArticleIndexFile {
    return {
        version: ARTICLE_INDEX_VERSION,
        sourceUpdatedAt,
        articles: articles.map((article) => ({
            slug: article.slug || article.id,
            slugArray: [article.slug || article.id],
            title: article.title || 'Untitled',
            date: normalizeDate(article.date),
            description: article.description || '',
            updatedDate: normalizeDate(article.updatedDate),
            tags: article.tags || [],
            kind: normalizeArticleKind(article.kind),
            status: normalizeArticleStatus(article.status),
            category: normalizeOptionalString(article.category),
            series: normalizeOptionalString(article.series),
            featured: Boolean(article.featured),
            readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(article.content) / 450)),
            sourceLinks: normalizeSourceLinks(article.sourceLinks),
            revisionNotes: normalizeRevisionNotes(article.revisionNotes),
        })),
    };
}

export function parseArticleIndex(value: unknown): ArticleIndexFile | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<ArticleIndexFile>;
    if (candidate.version !== ARTICLE_INDEX_VERSION || !Array.isArray(candidate.articles)) return null;
    if (typeof candidate.sourceUpdatedAt !== 'string') return null;
    return candidate as ArticleIndexFile;
}
