import { createCanonicalUrl } from '@/lib/site-url';

interface ArticleStructuredDataInput {
    title: string;
    description?: string;
    canonicalUrl: string;
    publishedDate?: string;
    modifiedDate?: string;
    tags: string[];
    category?: string;
    siteName: string;
}

interface BreadcrumbEntry {
    name: string;
    path: string;
}

interface WebSiteStructuredDataInput {
    siteName: string;
    siteDescription: string;
}

export function createArticleStructuredData(input: ArticleStructuredDataInput): Record<string, unknown> {
    const modifiedDate = input.modifiedDate || input.publishedDate;

    return {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: input.title,
        ...(input.description ? { description: input.description } : {}),
        mainEntityOfPage: {
            '@type': 'WebPage',
            '@id': input.canonicalUrl,
        },
        url: input.canonicalUrl,
        ...(input.publishedDate ? { datePublished: input.publishedDate } : {}),
        ...(modifiedDate ? { dateModified: modifiedDate } : {}),
        ...(input.tags.length ? { keywords: input.tags.join(', ') } : {}),
        ...(input.category ? { articleSection: input.category } : {}),
        publisher: {
            '@type': 'Organization',
            name: input.siteName,
            url: createCanonicalUrl('/'),
        },
    };
}

export function createBreadcrumbStructuredData(entries: BreadcrumbEntry[]): Record<string, unknown> {
    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: entries.map((entry, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: entry.name,
            item: createCanonicalUrl(entry.path),
        })),
    };
}

// No `potentialAction`/SearchAction here on purpose: search is a command
// palette backed by a JSON API, and there is no user-visitable results URL to
// hand a search engine. Declaring one would point crawlers at raw JSON.
export function createWebSiteStructuredData(input: WebSiteStructuredDataInput): Record<string, unknown> {
    return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: input.siteName,
        ...(input.siteDescription ? { description: input.siteDescription } : {}),
        url: createCanonicalUrl('/'),
    };
}
