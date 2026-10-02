import type { MetadataRoute } from 'next';
import snapshot from '@/public-site/snapshot';

export const dynamic = 'force-static';

const siteUrl = 'https://guanlangzg.github.io';
const generatedDate = '2026-09-30';

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        { url: `${siteUrl}/`, lastModified: generatedDate },
        { url: `${siteUrl}/blog/`, lastModified: generatedDate },
        { url: `${siteUrl}/navigation/`, lastModified: generatedDate },
        { url: `${siteUrl}/search/`, lastModified: generatedDate },
        ...snapshot.posts.map((post) => ({ url: `${siteUrl}/posts/${encodeURIComponent(post.slug)}/`, lastModified: post.date })),
    ];
}
