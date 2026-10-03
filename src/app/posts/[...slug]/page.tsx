import type { Metadata } from 'next';
import { getPostBySlugArrayAsync, getRelatedPostsAsync } from '@/lib/markdown';
import { MarkdownContent } from '@/app/components/markdown';
import { JsonLd, PageHero, PostCard, ReadingProgress, TableOfContents } from '@/app/components/ui';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CalendarDays, Clock3, History, LinkIcon, Tag } from 'lucide-react';
import { getArticleKindLabel, getArticleStatusLabel } from '@/lib/article-metadata';
import { getMarkdownHeadings } from '@/lib/article-quality';
import { readSiteSettingsFromDiskAsync } from '@/lib/editor-data-storage';
import { createOgImagePath, getSiteUrl } from '@/lib/site-url';
import { createArticleStructuredData, createBreadcrumbStructuredData } from '@/lib/structured-data';

export const dynamic = 'force-dynamic';

function createPostPath(slugArray: string[]): string {
    return `/posts/${slugArray.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function createPostCanonicalUrl(slugArray: string[]): string {
    return new URL(createPostPath(slugArray), getSiteUrl()).toString();
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
    const resolvedParams = await params;
    const post = await getPostBySlugArrayAsync(resolvedParams.slug);

    if (!post) {
        return { title: '文章未找到' };
    }

    return {
        title: post.meta.title,
        description: post.meta.description,
        alternates: {
            canonical: createPostCanonicalUrl(post.meta.slugArray),
        },
        openGraph: {
            title: post.meta.title,
            description: post.meta.description,
            type: 'article',
            publishedTime: post.meta.date || undefined,
            modifiedTime: post.meta.updatedDate || undefined,
            tags: post.meta.tags,
            images: [
                createOgImagePath({
                    title: post.meta.title,
                    description: post.meta.description,
                }),
            ],
        },
        twitter: {
            card: 'summary_large_image',
            title: post.meta.title,
            description: post.meta.description,
            images: [
                createOgImagePath({
                    title: post.meta.title,
                    description: post.meta.description,
                }),
            ],
        },
    };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string[] }> }) {
    const resolvedParams = await params;
    const post = await getPostBySlugArrayAsync(resolvedParams.slug);

    if (!post) {
        notFound();
    }

    const headings = getMarkdownHeadings(post.content).filter((heading) => heading.level >= 2);
    const [relatedPosts, settings] = await Promise.all([
        getRelatedPostsAsync(post.meta, 4),
        readSiteSettingsFromDiskAsync(),
    ]);
    const visibleTags = post.meta.tags.slice(0, 4);
    const hiddenTagCount = Math.max(post.meta.tags.length - visibleTags.length, 0);
    const canonicalUrl = createPostCanonicalUrl(post.meta.slugArray);

    return (
        <>
            <JsonLd
                data={createArticleStructuredData({
                    title: post.meta.title,
                    description: post.meta.description,
                    canonicalUrl,
                    publishedDate: post.meta.date,
                    modifiedDate: post.meta.updatedDate,
                    tags: post.meta.tags,
                    category: post.meta.category,
                    siteName: settings.siteName,
                })}
            />
            <JsonLd
                data={createBreadcrumbStructuredData([
                    { name: settings.siteName, path: '/' },
                    { name: '文章归档', path: '/blog' },
                    { name: post.meta.title, path: createPostPath(post.meta.slugArray) },
                ])}
            />
            <ReadingProgress />
            <div className="mx-auto max-w-5xl pb-10">
                <Link
                    href="/blog"
                    className="mb-5 inline-flex min-h-[44px] items-center gap-2 rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors duration-token-fast hover:border-border-focus hover:text-fg"
                >
                    <ArrowLeft className="h-4 w-4 text-subtle" />
                    返回归档
                </Link>

                <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-10">
                    <article className="min-w-0">
                        <PageHero
                            className="pb-6 lg:grid-cols-1"
                            eyebrow={(
                                <span className="flex flex-wrap items-center gap-3 text-subtle">
                                    <span className="rounded-token-badge border border-border bg-surface px-2 py-1 text-accent">
                                        {getArticleKindLabel(post.meta.kind)}
                                    </span>
                                    {post.meta.status !== 'published' ? (
                                        <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                                            {getArticleStatusLabel(post.meta.status)}
                                        </span>
                                    ) : null}
                                    <span className="inline-flex items-center gap-2">
                                        <CalendarDays className="h-4 w-4" />
                                        <time dateTime={post.meta.date || undefined}>{post.meta.date || 'UNTRACKED'}</time>
                                    </span>
                                    <span className="inline-flex items-center gap-2">
                                        <Clock3 className="h-4 w-4" />
                                        {post.meta.readingMinutes} 分钟
                                    </span>
                                </span>
                            )}
                            title={post.meta.title}
                            description={post.meta.description ? (
                                <p className="border-l-2 border-accent pl-4 text-base leading-relaxed text-muted">
                                    {post.meta.description}
                                </p>
                            ) : null}
                        />

                        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-muted">
                            {post.meta.category ? (
                                <span className="rounded-token-badge bg-accent-50 px-2 py-1 text-accent">
                                    {post.meta.category}
                                </span>
                            ) : null}
                            {post.meta.series ? (
                                <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                                    {post.meta.series}
                                </span>
                            ) : null}
                            {post.meta.updatedDate ? (
                                <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                                    修订 <time dateTime={post.meta.updatedDate}>{post.meta.updatedDate}</time>
                                </span>
                            ) : null}
                            {post.meta.tags.length ? (
                                <span className="inline-flex min-w-0 items-center gap-1">
                                    <Tag className="h-4 w-4 shrink-0 text-subtle" />
                                    <span className="truncate">{visibleTags.join(', ')}</span>
                                    {hiddenTagCount > 0 ? (
                                        <span className="shrink-0 rounded-token-badge border border-border-soft bg-surface px-1.5 py-0.5 font-mono text-xs text-subtle">
                                            +{hiddenTagCount}
                                        </span>
                                    ) : null}
                                </span>
                            ) : null}
                        </div>

                        <MarkdownContent
                            content={post.content}
                            className="mt-5 rounded-token-card border border-border bg-surface p-4 md:p-6"
                            skipDuplicateTitle={post.meta.title}
                        />

                        {post.meta.sourceLinks.length ? (
                            <section className="mt-6 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                                <div className="flex items-center gap-2">
                                    <LinkIcon className="h-4 w-4 text-subtle" />
                                    <h2 className="font-semibold text-fg">参考资料</h2>
                                </div>
                                <ul className="mt-3 space-y-2 text-sm">
                                    {post.meta.sourceLinks.map((source) => (
                                        <li key={`${source.title}-${source.url}`}>
                                            <a
                                                href={source.url}
                                                className="font-medium text-accent hover:text-accent-800"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {source.title}
                                            </a>
                                            {source.note ? <p className="mt-1 text-muted">{source.note}</p> : null}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}

                        {post.meta.revisionNotes.length ? (
                            <section className="mt-6 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                                <div className="flex items-center gap-2">
                                    <History className="h-4 w-4 text-subtle" />
                                    <h2 className="font-semibold text-fg">修订记录</h2>
                                </div>
                                <ul className="mt-3 space-y-2 text-sm text-muted">
                                    {post.meta.revisionNotes.map((revision) => (
                                        <li key={`${revision.date}-${revision.note}`}>
                                            <span className="font-mono text-xs text-subtle">{revision.date}</span>
                                            <span className="ml-2">{revision.note}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}

                        {relatedPosts.length ? (
                            <section className="mt-6 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                                <h2 className="font-semibold text-fg">相关内容</h2>
                                <div className="mt-3 space-y-3">
                                    {relatedPosts.map((related) => (
                                        <PostCard
                                            key={related.slug}
                                            title={related.title}
                                            description={related.description}
                                            date={related.date || 'UNTRACKED'}
                                            href={`/posts/${related.slug}`}
                                        />
                                    ))}
                                </div>
                            </section>
                        ) : null}
                    </article>

                    {headings.length >= 4 ? (
                        <aside className="hidden lg:block">
                            <TableOfContents headings={headings} />
                        </aside>
                    ) : null}
                </div>
            </div>
        </>
    );
}
