import { NextRequest, NextResponse } from 'next/server';
import { ensureEditorSession } from '@/lib/editor-api-auth';
import { getPublicLiveSnapshot, isLiveReaderRuntime, type PublicLiveSnapshot } from '@/lib/live-public-reader';
import { readNavigationFromDiskAsync } from '@/lib/editor-data-storage';
import { getSearchablePostsAsync } from '@/lib/markdown';
import { readSearchIndexFromDiskAsync, type SearchIndexDocument } from '@/lib/search-index';
import { getAnonymousSearchBudgetResponse, getSearchRateLimitResponse } from '@/lib/search-rate-limit';
import {
    isSearchQueryAllowed,
    normalizeSearchQuery,
} from '@/lib/search-query';

export const dynamic = 'force-dynamic';

// Caps the number of documents scanned in the fallback path (when the derived
// search index is missing) to bound memory and CPU usage on large datasets.
const FALLBACK_MAX_DOCUMENTS = 500;
const FALLBACK_MAX_TOOLS = 1000;

function includesQuery(parts: string[], query: string): boolean {
    return parts.join('\n').toLowerCase().includes(query);
}

function normalizeSearchText(value: string): string {
    return value.toLowerCase();
}

function getMatchScore(value: string, query: string, weight: number): number {
    const normalized = normalizeSearchText(value);

    if (normalized.includes(query)) {
        return weight;
    }

    const terms = query.split(' ').filter(Boolean);

    if (terms.length > 1 && terms.every((term) => normalized.includes(term))) {
        return Math.max(1, Math.floor(weight * 0.7));
    }

    return 0;
}

function getPostSearchScore(parts: {
    title: string;
    description: string;
    slug: string;
    tags: string[];
    content: string;
}, query: string): number {
    return (
        getMatchScore(parts.title, query, 50) +
        getMatchScore(parts.tags.join(' '), query, 35) +
        getMatchScore(parts.description, query, 25) +
        getMatchScore(parts.slug, query, 20) +
        getMatchScore(parts.content, query, 8)
    );
}

function getToolSearchScore(parts: {
    categoryName: string;
    title: string;
    description: string;
    url: string;
    tags: string[];
}, query: string): number {
    return (
        getMatchScore(parts.title, query, 50) +
        getMatchScore(parts.tags.join(' '), query, 35) +
        getMatchScore(parts.categoryName, query, 25) +
        getMatchScore(parts.description, query, 20) +
        getMatchScore(parts.url, query, 10)
    );
}

async function getSearchDocuments(live: PublicLiveSnapshot | null): Promise<SearchIndexDocument[]> {
    if (live) {
        const posts = live.articles;
        const navigation = live.navigation;
        return [...posts
            .map((article) => ({
                meta: {
                    title: article.title,
                    slug: article.slug ?? article.id,
                    description: article.description,
                    date: article.date,
                    tags: article.tags,
                    slugArray: [article.slug ?? article.id],
                },
                content: article.content,
            }))
            .filter((post) => !post.meta.slugArray.includes('navigation'))
            .map((post) => ({
                type: 'post' as const,
                title: post.meta.title,
                slug: post.meta.slug,
                href: `/posts/${post.meta.slug}`,
                description: post.meta.description ?? '',
                date: post.meta.date,
                tags: post.meta.tags,
                content: post.content,
            })),
        ...navigation.flatMap((category) => category.tools.map((tool) => ({
            type: 'tool' as const,
            title: tool.title,
            slug: tool.url,
            href: tool.url,
            description: tool.description,
            categoryName: category.name,
            tags: tool.tags,
            url: tool.url,
        })))];
    }
    const index = await readSearchIndexFromDiskAsync().catch((error: unknown) => {
        console.warn('[search] Failed to read derived search index; falling back to source data:', error);
        return null;
    });

    if (index) {
        return index.documents;
    }

    const [posts, navigation] = await Promise.all([
        getSearchablePostsAsync(),
        readNavigationFromDiskAsync(),
    ]);
    const filteredPosts = posts.filter((post) => !post.meta.slugArray.includes('navigation'));

    if (filteredPosts.length > FALLBACK_MAX_DOCUMENTS) {
        console.warn(
            `[search] Fallback path scanned ${filteredPosts.length} posts; capping to ${FALLBACK_MAX_DOCUMENTS}.`
        );
    }

    const postDocuments: SearchIndexDocument[] = filteredPosts
        .slice(0, FALLBACK_MAX_DOCUMENTS)
        .map((post) => ({
            type: 'post',
            title: post.meta.title,
            slug: post.meta.slug,
            href: `/posts/${post.meta.slug}`,
            description: post.meta.description ?? '',
            date: post.meta.date,
            tags: post.meta.tags,
            content: post.content,
        }));
    const allToolDocuments: SearchIndexDocument[] = navigation.flatMap((category) =>
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

    if (allToolDocuments.length > FALLBACK_MAX_TOOLS) {
        console.warn(
            `[search] Fallback path scanned ${allToolDocuments.length} tools; capping to ${FALLBACK_MAX_TOOLS}.`
        );
    }

    const toolDocuments = allToolDocuments.slice(0, FALLBACK_MAX_TOOLS);

    return [...postDocuments, ...toolDocuments];
}

/**
 * Signed-in searches use the working-copy index. Anonymous production searches are built only
 * from one verified live release snapshot and never fall back to draft storage.
 */
export async function GET(request: NextRequest) {
    const isPublicReader = isLiveReaderRuntime();
    const live = isPublicReader ? getPublicLiveSnapshot() : null;

    if (!isPublicReader) {
        const authError = await ensureEditorSession(request);
        if (authError) return authError;
    }

    const query = normalizeSearchQuery(request.nextUrl.searchParams.get('q'));

    if (!isSearchQueryAllowed(query)) {
        return NextResponse.json([]);
    }

    const rateLimitResponse = getSearchRateLimitResponse(request);

    if (rateLimitResponse) {
        return rateLimitResponse;
    }

    if (isPublicReader) {
        // Beyond the per-client limit, an anonymous scan also spends from one shared budget so a
        // spoofable X-Forwarded-For cannot buy unlimited work by rotating identities.
        const budgetResponse = getAnonymousSearchBudgetResponse();

        if (budgetResponse) {
            return budgetResponse;
        }
    }

    const documents = await getSearchDocuments(live);

    const postResults = documents
        .filter((document): document is Extract<SearchIndexDocument, { type: 'post' }> => document.type === 'post')
        .map((post) => ({
            score: getPostSearchScore({
                title: post.title,
                description: post.description,
                slug: post.slug,
                tags: post.tags,
                content: post.content,
            }, query),
            post,
        }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || right.post.date.localeCompare(left.post.date))
        .slice(0, 5)
        .map(({ post }) => ({
            type: 'post' as const,
            title: post.title,
            slug: post.slug,
            href: `/posts/${post.slug}`,
            description: post.description,
            meta: post.date || '文章',
            external: false,
        }));

    const toolResults = documents
        .filter((document): document is Extract<SearchIndexDocument, { type: 'tool' }> => document.type === 'tool')
        .map((tool) => ({
            score: getToolSearchScore({
                categoryName: tool.categoryName,
                title: tool.title,
                description: tool.description,
                url: tool.url,
                tags: tool.tags,
            }, query),
            tool,
        }))
        .filter(({ score, tool }) =>
            score > 0 ||
            includesQuery([tool.categoryName, tool.title, tool.description, tool.url, ...tool.tags], query)
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, 5)
        .map(({ tool }) => ({
            type: 'tool' as const,
            title: tool.title,
            slug: tool.url,
            href: tool.url,
            description: tool.description,
            meta: tool.categoryName,
            external: true,
            tags: tool.tags,
        }));

    const results = [...postResults, ...toolResults].slice(0, 8);

    return NextResponse.json(results);
}
