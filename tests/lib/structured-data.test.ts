import { describe, expect, it, vi } from 'vitest';
import {
    createArticleStructuredData,
    createBreadcrumbStructuredData,
    createWebSiteStructuredData,
} from '@/lib/structured-data';

vi.mock('@/lib/site-url', () => ({
    createCanonicalUrl: (pathname: string) => new URL(pathname, 'https://blog.example.com').toString(),
}));

const fullArticle = {
    title: 'Hello World',
    description: 'Article description',
    canonicalUrl: 'https://blog.example.com/posts/hello-world',
    publishedDate: '2026-05-25',
    modifiedDate: '2026-05-26',
    tags: ['nextjs', 'seo'],
    category: 'Engineering',
    siteName: 'Example Blog',
};

describe('createArticleStructuredData', () => {
    it('describes a fully populated article', () => {
        expect(createArticleStructuredData(fullArticle)).toEqual({
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: 'Hello World',
            description: 'Article description',
            mainEntityOfPage: {
                '@type': 'WebPage',
                '@id': 'https://blog.example.com/posts/hello-world',
            },
            url: 'https://blog.example.com/posts/hello-world',
            datePublished: '2026-05-25',
            dateModified: '2026-05-26',
            keywords: 'nextjs, seo',
            articleSection: 'Engineering',
            publisher: {
                '@type': 'Organization',
                name: 'Example Blog',
                url: 'https://blog.example.com/',
            },
        });
    });

    it('falls back to the published date when the article was never revised', () => {
        const data = createArticleStructuredData({
            ...fullArticle,
            modifiedDate: undefined,
        });

        expect(data.dateModified).toBe('2026-05-25');
    });

    it('omits optional keys instead of emitting undefined or empty values', () => {
        const data = createArticleStructuredData({
            title: 'Bare',
            description: undefined,
            canonicalUrl: 'https://blog.example.com/posts/bare',
            publishedDate: '',
            modifiedDate: undefined,
            tags: [],
            category: undefined,
            siteName: 'Example Blog',
        });

        expect(data).not.toHaveProperty('description');
        expect(data).not.toHaveProperty('datePublished');
        expect(data).not.toHaveProperty('dateModified');
        expect(data).not.toHaveProperty('keywords');
        expect(data).not.toHaveProperty('articleSection');
        expect(JSON.stringify(data)).not.toContain('undefined');
    });
});

describe('createBreadcrumbStructuredData', () => {
    it('numbers breadcrumb positions from one and absolutizes paths', () => {
        expect(createBreadcrumbStructuredData([
            { name: 'Example Blog', path: '/' },
            { name: '文章归档', path: '/blog' },
            { name: 'Hello World', path: '/posts/hello-world' },
        ])).toEqual({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                {
                    '@type': 'ListItem',
                    position: 1,
                    name: 'Example Blog',
                    item: 'https://blog.example.com/',
                },
                {
                    '@type': 'ListItem',
                    position: 2,
                    name: '文章归档',
                    item: 'https://blog.example.com/blog',
                },
                {
                    '@type': 'ListItem',
                    position: 3,
                    name: 'Hello World',
                    item: 'https://blog.example.com/posts/hello-world',
                },
            ],
        });
    });
});

describe('createWebSiteStructuredData', () => {
    it('describes the site without advertising an unvisitable search endpoint', () => {
        const data = createWebSiteStructuredData({
            siteName: 'Example Blog',
            siteDescription: 'Engineering notes',
        });

        expect(data).toEqual({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Example Blog',
            description: 'Engineering notes',
            url: 'https://blog.example.com/',
        });
        expect(data).not.toHaveProperty('potentialAction');
    });

    it('omits a blank site description', () => {
        expect(createWebSiteStructuredData({
            siteName: 'Example Blog',
            siteDescription: '',
        })).not.toHaveProperty('description');
    });
});
