import type { MetadataRoute } from 'next';
import { getPostsAsync } from '@/lib/markdown';
import { getSiteUrl } from '@/lib/site-url';

export const revalidate = 3600;

function createUrl(pathname: string): string {
    return new URL(pathname, getSiteUrl()).toString();
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const posts = (await getPostsAsync()).filter((post) => !post.slugArray.includes('navigation'));
    const now = new Date();
    const staticRoutes: MetadataRoute.Sitemap = [
        {
            url: createUrl('/'),
            lastModified: now,
            changeFrequency: 'weekly',
            priority: 1,
        },
        {
            url: createUrl('/blog'),
            lastModified: now,
            changeFrequency: 'weekly',
            priority: 0.8,
        },
        {
            url: createUrl('/navigation'),
            lastModified: now,
            changeFrequency: 'weekly',
            priority: 0.7,
        },
    ];

    return [
        ...staticRoutes,
        ...posts.map((post) => ({
            url: createUrl(`/posts/${post.slug}`),
            lastModified: post.updatedDate || post.date || now,
            changeFrequency: 'monthly' as const,
            priority: post.featured ? 0.8 : 0.6,
        })),
    ];
}
