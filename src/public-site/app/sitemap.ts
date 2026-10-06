import type { MetadataRoute } from 'next';
import snapshot, { parseSnapshotDate } from '@/public-site/snapshot';

export const dynamic = 'force-static';

const siteUrl = 'https://guanlangzg.github.io';
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: `${siteUrl}/` },
        { url: `${siteUrl}/blog/` },
        { url: `${siteUrl}/navigation/` },
        { url: `${siteUrl}/search/` },
        ...snapshot.posts.map((post) => ({
            url: `${siteUrl}/posts/${encodeURIComponent(post.slug)}/`,
            // The editor's own calendar day is published as written; a value that is not a real
            // calendar day is dropped instead of emitting a `<lastmod>` search engines reject.
            ...(parseSnapshotDate(post.date) ? { lastModified: post.date } : {}),
        })),
    ];
}
