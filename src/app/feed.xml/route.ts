import { NextResponse } from 'next/server';
import { getPostsAsync } from '@/lib/markdown';
import { readSiteSettingsFromDiskAsync } from '@/lib/editor-data-storage';
import { getSiteUrl } from '@/lib/site-url';

export const dynamic = 'force-dynamic';

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function createAbsoluteUrl(pathname: string): string {
    return new URL(pathname, getSiteUrl()).toString();
}

function formatRssDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return new Date().toUTCString();
    }

    return date.toUTCString();
}

export async function GET(): Promise<NextResponse> {
    const [settings, posts] = await Promise.all([
        readSiteSettingsFromDiskAsync(),
        getPostsAsync(),
    ]);
    const publicPosts = posts.filter((post) => !post.slugArray.includes('navigation'));
    const latestPostDate = publicPosts
        .map((post) => post.updatedDate || post.date)
        .filter(Boolean)
        .sort()
        .at(-1);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(settings.siteName)}</title>
    <link>${escapeXml(createAbsoluteUrl('/'))}</link>
    <description>${escapeXml(settings.siteDescription)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${formatRssDate(latestPostDate || new Date())}</lastBuildDate>
    <atom:link href="${escapeXml(createAbsoluteUrl('/feed.xml'))}" rel="self" type="application/rss+xml" />
${publicPosts.map((post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(createAbsoluteUrl(`/posts/${post.slug}`))}</link>
      <guid isPermaLink="true">${escapeXml(createAbsoluteUrl(`/posts/${post.slug}`))}</guid>
      <description>${escapeXml(post.description || '')}</description>
      <pubDate>${formatRssDate(post.date || post.updatedDate || new Date())}</pubDate>
${post.updatedDate ? `      <atom:updated>${escapeXml(new Date(post.updatedDate).toISOString())}</atom:updated>
` : ''}${post.tags.map((tag) => `      <category>${escapeXml(tag)}</category>`).join('\n')}
    </item>`).join('\n')}
  </channel>
</rss>
`;

    return new NextResponse(body, {
        headers: {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
