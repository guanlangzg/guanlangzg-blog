import type { MetadataRoute } from 'next';
import { getLivePostsFromSnapshot, getPostsAsync } from '@/lib/markdown';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { getSiteUrl } from '@/lib/site-url';

// The sitemap must describe the release the reader pages currently serve, so it cannot be a cached
// generation: a stale ISR copy would advertise a previous release for up to an hour.
export const dynamic = 'force-dynamic';

function createUrl(pathname: string): string {
    return new URL(pathname, getSiteUrl()).toString();
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const live = isLiveReaderRuntime() ? getPublicLiveSnapshot() : null;
    const posts = (live ? getLivePostsFromSnapshot(live) : await getPostsAsync())
        .filter((post) => !post.slugArray.includes('navigation'));
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
