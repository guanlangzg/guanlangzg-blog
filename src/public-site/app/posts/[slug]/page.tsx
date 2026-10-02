import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getStaticAssetUrl } from '@/public-site/paths';
import { MarkdownContent } from '@/app/components/markdown/MarkdownContent';
import { PageHero } from '@/app/components/ui/PageHero';
import snapshot from '@/public-site/snapshot';

const SITE_ORIGIN = 'https://guanlangzg.github.io';

export const dynamicParams = false;

export function generateStaticParams() {
    return snapshot.posts.map((post) => ({ slug: post.slug }));
}

function findPostByRouteSlug(routeSlug: string) {
    let decodedSlug: string;
    try {
        decodedSlug = decodeURIComponent(routeSlug);
    } catch {
        return undefined;
    }
    return snapshot.posts.find((item) => item.slug === decodedSlug);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const { slug } = await params;
    const post = findPostByRouteSlug(slug);
    return post ? {
        title: post.title,
        description: post.description,
        alternates: { canonical: `${SITE_ORIGIN}/posts/${encodeURIComponent(post.slug)}/` },
        openGraph: { title: post.title, description: post.description, url: `${SITE_ORIGIN}/posts/${encodeURIComponent(post.slug)}/`, images: [`${SITE_ORIGIN}${getStaticAssetUrl(snapshot.releaseId, `og/${post.slug}.png`)}`] },
    } : { title: '文章未找到' };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const post = findPostByRouteSlug(slug);
    if (!post) notFound();
    return <article className="mx-auto max-w-4xl"><a href="/blog/" className="mb-5 inline-flex rounded-token-button border border-border bg-surface px-4 py-2 text-sm text-muted">← 返回归档</a><PageHero eyebrow={`${post.date} · ${post.tags.join(' · ')}`} title={post.title} description={post.description} /><MarkdownContent content={post.content} className="mt-6 rounded-token-card border border-border bg-surface p-5 md:p-8" skipDuplicateTitle={post.title} /></article>;
}
