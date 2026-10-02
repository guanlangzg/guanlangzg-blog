import snapshot from '@/public-site/snapshot';

const SITE_ORIGIN = 'https://guanlangzg.github.io';

function escapeXml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export const dynamic = 'force-static';

export function GET() {
    const posts = snapshot.posts.map((post) => `<item><title>${escapeXml(post.title)}</title><link>${SITE_ORIGIN}/posts/${encodeURIComponent(post.slug)}/</link><guid isPermaLink="true">${SITE_ORIGIN}/posts/${encodeURIComponent(post.slug)}/</guid><pubDate>${new Date(`${post.date}T00:00:00Z`).toUTCString()}</pubDate><description>${escapeXml(post.description)}</description></item>`).join('');
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(snapshot.site.title)}</title><link>${SITE_ORIGIN}/</link><description>${escapeXml(snapshot.site.description)}</description>${posts}</channel></rss>`, {
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
}
