import snapshot from '@/public-site/snapshot';
import { createPublicSearchDocument } from '@/public-site/search-index';
import type { PublicSearchDocument } from '@/public-site/types';

export const dynamic = 'force-static';

export function GET() {
    const documents: PublicSearchDocument[] = [
        ...snapshot.posts.map((post) => createPublicSearchDocument({
            type: 'post',
            title: post.title,
            description: post.description,
            href: `/posts/${encodeURIComponent(post.slug)}/`,
            text: post.content,
            tags: post.tags,
        })),
        ...snapshot.navigation.flatMap((group) => group.items.map((item) => createPublicSearchDocument({
            type: 'navigation',
            title: item.title,
            description: `${group.name} · ${item.description}`,
            href: item.url,
            text: `${group.name} ${item.title} ${item.description} ${item.url}`,
            tags: item.tags,
        }))),
    ];
    return Response.json({ version: 1, releaseId: snapshot.releaseId, documents }, {
        headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
    });
}
