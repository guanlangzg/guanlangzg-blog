import type { MetadataRoute } from 'next';
import snapshot from '@/public-site/snapshot';

export const dynamic = 'force-static';

const siteUrl = 'https://guanlangzg.github.io';
export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: `${siteUrl}/` },
        { url: `${siteUrl}/blog/` },
        { url: `${siteUrl}/navigation/` },
        { url: `${siteUrl}/search/` },
        ...snapshot.posts.map((post) => ({ url: `${siteUrl}/posts/${encodeURIComponent(post.slug)}/`, lastModified: post.date })),
    ];
}
