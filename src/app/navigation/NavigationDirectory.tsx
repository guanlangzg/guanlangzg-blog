'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Grid2X2, Search, X } from 'lucide-react';
import { CategoryCard } from '@/app/components/navigation';
import { EmptyState } from '@/app/components/ui';
import type { Category } from '@/app/types/navigation';

interface NavigationDirectoryProps {
    categories: Category[];
    totalLinkCount: number;
}

function includesQuery(parts: string[], query: string): boolean {
    return parts.join('\n').toLowerCase().includes(query);
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

export function NavigationDirectory({ categories, totalLinkCount }: NavigationDirectoryProps) {
    const [activeSlug, setActiveSlug] = useState('all');
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const normalizedQuery = query.trim().toLowerCase();
    const activeCategory = categories.find((category) => category.slug === activeSlug);
    const filteredCategories = useMemo(() => {
        return categories
            .filter((category) => activeSlug === 'all' || category.slug === activeSlug)
            .map((category) => ({
                ...category,
                tools: normalizedQuery
                    ? category.tools.filter((tool) =>
                        includesQuery(
                            [category.name, tool.title, tool.description, tool.url, ...tool.tags],
                            normalizedQuery
                        )
                    )
                    : category.tools,
            }))
            .filter((category) => category.tools.length > 0 || !normalizedQuery);
    }, [activeSlug, categories, normalizedQuery]);
    const visibleToolCount = filteredCategories.reduce((total, category) => total + category.tools.length, 0);
    const activeLabel = activeCategory ? activeCategory.name : '全部分类';

    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if (event.key !== '/' || isEditableTarget(event.target)) {
                return;
            }

            event.preventDefault();
            inputRef.current?.focus();
        }

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <div className="space-y-4">
            <section className="rounded-token-card border border-border bg-surface-elevated p-2.5 md:p-3">
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-stretch">
                    <label className="flex min-h-[44px] items-center gap-2.5 rounded-token-input border border-border bg-bg px-3 py-0 transition-colors duration-token-fast focus-within:border-link focus-within:bg-white">
                        <Search className="h-4 w-4 text-accent" />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="搜索链接... (按 / 聚焦)"
                            aria-label="搜索导航链接"
                            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
                        />
                        <span className="hidden font-mono text-[0.68rem] text-subtle sm:inline">title/tag/url</span>
                        {query ? (
                            <button
                                type="button"
                                onClick={() => setQuery('')}
                                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-token-full text-subtle transition-colors duration-token-fast hover:bg-warm-100 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                aria-label="清空搜索"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        ) : null}
                    </label>

                    <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-token-card border border-warm-700 bg-warm-900 px-3 py-2 text-warm-100">
                        <div className="flex min-w-0 items-center gap-2">
                            <Grid2X2 className="h-4 w-4 text-accent-200" />
                            <span className="truncate text-xs text-warm-100/68">{activeLabel}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                            <span className="text-lg font-semibold leading-none">{visibleToolCount}</span>
                            <span className="font-mono text-xs text-warm-100/55" aria-live="polite">
                                /{totalLinkCount}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="relative mt-2">
                    <div className="flex gap-2 overflow-x-auto pb-1 pr-9 [scrollbar-width:thin] sm:pr-2" aria-label="导航分类">
                        <button
                            type="button"
                            onClick={() => setActiveSlug('all')}
                            aria-pressed={activeSlug === 'all'}
                            className={activeSlug === 'all'
                                ? 'min-h-[44px] shrink-0 rounded-token-full bg-fg px-4 py-2 text-xs font-medium text-surface shadow-token-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
                                : 'min-h-[44px] shrink-0 rounded-token-full border border-border bg-surface px-4 py-2 text-xs font-medium text-muted transition-colors duration-token-fast hover:border-accent-200 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'}
                        >
                            全部
                        </button>
                        {categories.map((category) => (
                            <button
                                key={category.slug}
                                type="button"
                                onClick={() => setActiveSlug(category.slug)}
                                aria-pressed={activeSlug === category.slug}
                                className={activeSlug === category.slug
                                    ? 'min-h-[44px] shrink-0 rounded-token-full bg-fg px-4 py-2 text-xs font-medium text-surface shadow-token-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
                                    : 'min-h-[44px] shrink-0 rounded-token-full border border-border bg-surface px-4 py-2 text-xs font-medium text-muted transition-colors duration-token-fast hover:border-accent-200 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'}
                            >
                                {category.name}
                                <span className="ml-1.5 font-mono text-[0.68rem] opacity-60">{category.tools.length}</span>
                            </button>
                        ))}
                    </div>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 right-0 w-9 bg-gradient-to-l from-surface-elevated via-surface-elevated/85 to-transparent sm:hidden"
                    />
                </div>
            </section>

            {filteredCategories.length === 0 || visibleToolCount === 0 ? (
                <EmptyState
                    title="没有匹配的链接"
                    description="换一个关键词，或切换到全部分类再试。"
                    action={(
                        <div className="flex flex-wrap justify-center gap-2">
                            {query ? (
                                <button
                                    type="button"
                                    onClick={() => setQuery('')}
                                    className="inline-flex min-h-[44px] items-center rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-fg transition hover:border-accent-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                >
                                    清空搜索并显示全部
                                </button>
                            ) : null}
                            {activeSlug !== 'all' ? (
                                <button
                                    type="button"
                                    onClick={() => setActiveSlug('all')}
                                    className="inline-flex min-h-[44px] items-center rounded-token-button bg-fg px-4 py-2 text-sm font-medium text-surface transition hover:bg-warm-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                >
                                    查看全部分类
                                </button>
                            ) : null}
                        </div>
                    )}
                />
            ) : (
                <div className="space-y-6">
                    {filteredCategories.map((category, categoryIndex) => (
                        <section
                            key={category.slug}
                            className="scroll-mt-24"
                        >
                            <div className="mb-2 flex items-end justify-between gap-3 border-b border-border/70 pb-2">
                                <div>
                                    <p className="font-mono text-xs tracking-token-caps text-accent uppercase">
                                        0{categoryIndex + 1} / {category.slug}
                                    </p>
                                    <h2 className="mt-0.5 text-lg font-semibold leading-tight tracking-token-normal text-fg">
                                        {category.name}
                                    </h2>
                                </div>
                                <div className="flex items-center gap-2 rounded-token-full border border-border-soft bg-surface/70 px-2.5 py-1.5 font-mono text-xs text-subtle">
                                    {category.tools.length} links
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {category.tools.map((tool) => (
                                    <a
                                        key={`${category.slug}-${tool.title}-${tool.url}`}
                                        href={tool.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block h-full rounded-token-card focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2"
                                        aria-label={`打开 ${tool.title}`}
                                    >
                                        <CategoryCard
                                            title={tool.title}
                                            description={tool.description}
                                            url={tool.url}
                                            tags={tool.tags}
                                        />
                                    </a>
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
