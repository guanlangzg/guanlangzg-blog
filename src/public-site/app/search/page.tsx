import { PageHero } from '@/app/components/ui/PageHero';
import { SearchView } from '@/public-site/components/SearchView';
import snapshot from '@/public-site/snapshot';
import type { PublicSearchDocument, PublicSearchIndex } from '@/public-site/types';
import { createPublicSearchDocument } from '@/public-site/search-index';

export default function SearchPage() {
    const documents: PublicSearchDocument[] = [
        ...snapshot.posts.map((post) => createPublicSearchDocument({ type: 'post', title: post.title, description: post.description, href: `/posts/${encodeURIComponent(post.slug)}/`, text: post.content, tags: [...post.tags] })),
        ...snapshot.navigation.flatMap((group) => group.items.map((item) => createPublicSearchDocument({ type: 'navigation', title: item.title, description: `${group.name} · ${item.description}`, href: item.url, text: `${group.name} ${item.title} ${item.description} ${item.url}`, tags: [...item.tags] }))),
    ];
    const index: PublicSearchIndex = { version: 1, releaseId: snapshot.releaseId, documents };
    return <><PageHero eyebrow="SEARCH" title="全站搜索" description="搜索文章标题、摘要、正文、标签和导航条目。" /><div className="mt-6"><SearchView index={index} /></div></>;
}
