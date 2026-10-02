'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { ArrowRight, CalendarDays, Clock3, Tag } from 'lucide-react';
import { EmptyState, PostCard } from '@/app/components/ui';
import type { PostMeta } from '@/lib/markdown';
import { ARTICLE_KIND_OPTIONS, getArticleKindLabel } from '@/lib/article-metadata';
import { cn } from '@/lib/utils';

function createFilterHref(filters: { kind?: string; category?: string }): string {
    const params = new URLSearchParams();

    if (filters.kind) {
        params.set('kind', filters.kind);
    }

    if (filters.category) {
        params.set('category', filters.category);
    }

    const query = params.toString();

    return query ? `/blog?${query}` : '/blog';
}

function cnFilter(active: boolean): string {
    return cn(
        'inline-flex min-h-[44px] items-center rounded-token-button border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-0',
        active
            ? 'border-accent-300 bg-accent-50 text-accent'
            : 'border-border bg-background text-muted hover:border-accent-200 hover:text-accent'
    );
}

export function BlogArchiveClient({ posts }: { posts: PostMeta[] }) {
    const searchParams = useSearchParams();
    const selectedKind = searchParams.get('kind') || '';
    const selectedCategory = searchParams.get('category') || '';
    const articlePosts = posts.filter((post) => (
        (!selectedKind || post.kind === selectedKind) &&
        (!selectedCategory || post.category === selectedCategory)
    ));
    const featuredPosts = posts
        .filter((post) => post.featured)
        .sort((first, second) => (second.updatedDate || second.date).localeCompare(first.updatedDate || first.date))
        .slice(0, 3);
    const categories = Array.from(
        new Set(posts.map((post) => post.category).filter(Boolean) as string[])
    ).sort();
    const postsByYear = articlePosts.reduce((acc, post) => {
        const year = post.date ? post.date.split('-')[0] : '未分类';

        if (!acc[year]) {
            acc[year] = [];
        }

        acc[year].push(post);
        return acc;
    }, {} as Record<string, PostMeta[]>);
    const sortedYears = Object.keys(postsByYear).sort((a, b) => b.localeCompare(a));

    return (
        <>
            {featuredPosts.length > 0 ? (
                <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold text-fg">精选入口</h2>
                        <Link href={createFilterHref({})} className="text-sm font-medium text-accent hover:text-accent-800">
                            查看全部
                        </Link>
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                        {featuredPosts.map((post) => (
                            <PostCard
                                key={post.slug}
                                title={post.title}
                                description={post.description}
                                date={post.updatedDate ? `更新 ${post.updatedDate}` : post.date}
                                href={`/posts/${post.slug}`}
                                className="h-full"
                            />
                        ))}
                    </div>
                </section>
            ) : null}

            <section className="flex flex-col gap-3 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                <div className="flex flex-wrap gap-2">
                    <Link
                        href={createFilterHref({ category: selectedCategory })}
                        className={cnFilter(!selectedKind)}
                        aria-current={!selectedKind ? 'page' : undefined}
                    >
                        全部类型
                    </Link>
                    {ARTICLE_KIND_OPTIONS.filter((option) => posts.some((post) => post.kind === option.value)).map((option) => (
                        <Link
                            key={option.value}
                            href={createFilterHref({ kind: option.value, category: selectedCategory })}
                            className={cnFilter(selectedKind === option.value)}
                            aria-current={selectedKind === option.value ? 'page' : undefined}
                        >
                            {option.label}
                        </Link>
                    ))}
                </div>
                {categories.length ? (
                    <div className="flex flex-wrap gap-2">
                        <Link
                            href={createFilterHref({ kind: selectedKind })}
                            className={cnFilter(!selectedCategory)}
                            aria-current={!selectedCategory ? 'page' : undefined}
                        >
                            全部分类
                        </Link>
                        {categories.map((category) => (
                            <Link
                                key={category}
                                href={createFilterHref({ kind: selectedKind, category })}
                                className={cnFilter(selectedCategory === category)}
                                aria-current={selectedCategory === category ? 'page' : undefined}
                            >
                                {category}
                            </Link>
                        ))}
                    </div>
                ) : null}
                <p className="text-sm text-muted">
                    共 {articlePosts.length} 篇{selectedKind || selectedCategory ? '（已筛选）' : ''}
                </p>
            </section>

            {articlePosts.length === 0 ? (
                <EmptyState title="暂无文章" description="创建文章后，归档会按年份自动聚合。" />
            ) : (
                <div className="grid gap-8 lg:grid-cols-[140px_1fr]">
                    <aside className="hidden lg:block">
                        <div className="sticky top-24 space-y-2">
                            {sortedYears.map((year) => (
                                <a
                                    key={year}
                                    href={`#year-${year}`}
                                    className="flex items-center justify-between rounded-token-button border border-border bg-surface px-3 py-2 text-sm text-muted transition-colors duration-token-fast hover:border-accent-200 hover:text-accent"
                                >
                                    <span>{year}</span>
                                    <span className="font-mono text-xs text-subtle">{postsByYear[year].length}</span>
                                </a>
                            ))}
                        </div>
                    </aside>

                    <div className="space-y-7">
                        {sortedYears.map((year) => (
                            <section
                                key={year}
                                id={`year-${year}`}
                                className="scroll-mt-24"
                            >
                                <div className="mb-5 flex items-center justify-between border-b border-border pb-3">
                                    <h2 className="text-2xl font-semibold text-fg">{year}</h2>
                                    <span className="rounded-token-badge border border-border-soft bg-surface px-2 py-1 font-mono text-xs text-subtle">
                                        {postsByYear[year].length} entries
                                    </span>
                                </div>

                                <div className="space-y-3">
                                    {postsByYear[year].map((post) => {
                                        const hasDate = Boolean(post.date);

                                        return (
                                            <Link
                                                key={post.slug}
                                                href={`/posts/${post.slug}`}
                                                className="group relative grid gap-4 overflow-hidden rounded-token-card border border-border bg-surface-elevated p-4 pr-12 transition-all duration-token-normal ease-token-out hover:-translate-y-0.5 hover:border-accent-300 hover:bg-accent-50/40 hover:shadow-token-card-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:translate-y-0 md:grid-cols-[120px_1fr_auto] md:items-center md:pr-4"
                                            >
                                                <span className="absolute inset-y-0 left-0 w-1 bg-accent opacity-0 transition-opacity duration-token-fast group-hover:opacity-100 group-focus-visible:opacity-100" />
                                                <div className="flex items-center gap-2 font-mono text-xs text-subtle">
                                                    <CalendarDays className="h-4 w-4 text-subtle" />
                                                    {hasDate
                                                        ? format(parseISO(post.date), 'MM月dd日', { locale: zhCN })
                                                        : 'UNTRACKED'}
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
                                                        <span className="rounded-token-badge bg-accent-50 px-2 py-1 text-accent">
                                                            {getArticleKindLabel(post.kind)}
                                                        </span>
                                                        {post.category ? <span>{post.category}</span> : null}
                                                        <span className="inline-flex items-center gap-1">
                                                            <Clock3 className="h-3.5 w-3.5" />
                                                            {post.readingMinutes} 分钟
                                                        </span>
                                                        {post.updatedDate ? <span>修订 {post.updatedDate}</span> : null}
                                                    </div>
                                                    <h3 className="text-base font-semibold text-fg transition-colors duration-token-fast group-hover:text-accent">
                                                        {post.title}
                                                    </h3>
                                                    {post.description ? (
                                                        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">
                                                            {post.description}
                                                        </p>
                                                    ) : null}
                                                    {post.tags.length ? (
                                                        <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-subtle">
                                                            <Tag className="h-3.5 w-3.5 shrink-0" />
                                                            <span className="truncate">{post.tags.slice(0, 4).join(', ')}</span>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <span className="absolute right-4 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-token-button border border-border-soft bg-surface text-subtle transition-all duration-token-fast group-hover:translate-x-1 group-hover:border-accent-200 group-hover:text-accent md:static md:translate-y-0">
                                                    <ArrowRight className="h-4 w-4" />
                                                </span>
                                            </Link>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}
