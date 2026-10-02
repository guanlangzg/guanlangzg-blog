import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { isPublicArticleStatus } from '@/lib/article-metadata';
import { createArticleSlug } from '@/lib/article-data';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';

const SEARCH_INDEX_VERSION = 1;

export type SearchIndexDocument =
    | {
        type: 'post';
        title: string;
        slug: string;
        href: string;
        description: string;
        date: string;
        tags: string[];
        content: string;
    }
    | {
        type: 'tool';
        title: string;
        slug: string;
        href: string;
        description: string;
        categoryName: string;
        tags: string[];
        url: string;
    };

export interface SearchIndex {
    version: typeof SEARCH_INDEX_VERSION;
    updatedAt: string;
    documents: SearchIndexDocument[];
}

export function getSearchIndexFilePath(): string {
    return path.join(getRuntimeDataRootPath(), 'indexes', 'search.json');
}

function getArticleSlug(article: Article): string {
    return article.slug || createArticleSlug(article);
}

export function createSearchIndex(input: {
    articles: Article[];
    navigation: Category[];
}): SearchIndex {
    const postDocuments: SearchIndexDocument[] = input.articles
        .filter((article) => isPublicArticleStatus(article.status))
        .map((article) => {
            const slug = getArticleSlug(article);

            return {
                type: 'post',
                title: article.title,
                slug,
                href: `/posts/${slug}`,
                description: article.description,
                date: article.date,
                tags: article.tags,
                content: article.content,
            };
        });
    const toolDocuments: SearchIndexDocument[] = input.navigation.flatMap((category) =>
        category.tools.map((tool) => ({
            type: 'tool',
            title: tool.title,
            slug: tool.url,
            href: tool.url,
            description: tool.description,
            categoryName: category.name,
            tags: tool.tags,
            url: tool.url,
        }))
    );

    return {
        version: SEARCH_INDEX_VERSION,
        updatedAt: new Date().toISOString(),
        documents: [...postDocuments, ...toolDocuments],
    };
}

export function writeSearchIndex(index: SearchIndex): void {
    writeJsonAtomically(getSearchIndexFilePath(), index);
}

export function writeSearchIndexForData(input: {
    articles: Article[];
    navigation: Category[];
}): void {
    writeSearchIndex(createSearchIndex(input));
}

function parseSearchIndex(value: unknown): SearchIndex | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as Partial<SearchIndex>;

    if (
        candidate.version !== SEARCH_INDEX_VERSION ||
        typeof candidate.updatedAt !== 'string' ||
        !Array.isArray(candidate.documents)
    ) {
        return null;
    }

    return candidate as SearchIndex;
}

export async function readSearchIndexFromDiskAsync(): Promise<SearchIndex | null> {
    const filePath = getSearchIndexFilePath();

    try {
        const content = await fsPromises.readFile(filePath, 'utf8');
        return parseSearchIndex(JSON.parse(content));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}
