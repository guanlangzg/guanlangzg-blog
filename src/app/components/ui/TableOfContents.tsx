'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MarkdownHeading } from '@/lib/article-quality';
import { cn } from '@/lib/utils';

interface TableOfContentsProps {
    headings: MarkdownHeading[];
}

export function TableOfContents({ headings }: TableOfContentsProps) {
    const visibleHeadings = useMemo(() => headings.slice(0, 12), [headings]);
    const [activeId, setActiveId] = useState(visibleHeadings[0]?.id || '');

    useEffect(() => {
        const headingIds = visibleHeadings.map((heading) => heading.id);
        const headingElements = headingIds
            .map((id) => document.getElementById(id))
            .filter((element): element is HTMLElement => Boolean(element));

        if (headingElements.length === 0) {
            return undefined;
        }

        const activeIds = new Set<string>();
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        activeIds.add(entry.target.id);
                    } else {
                        activeIds.delete(entry.target.id);
                    }
                }

                const nextActiveId = headingIds.find((id) => activeIds.has(id));

                if (nextActiveId) {
                    setActiveId(nextActiveId);
                }
            },
            {
                rootMargin: '-96px 0px -68% 0px',
                threshold: [0, 1],
            }
        );

        for (const element of headingElements) {
            observer.observe(element);
        }

        return () => observer.disconnect();
    }, [visibleHeadings]);

    if (visibleHeadings.length === 0) {
        return null;
    }

    return (
        <nav
            aria-label="文章目录"
            className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-token-card border border-border bg-surface p-4 text-sm shadow-token-card"
        >
            <h2 className="font-medium text-fg">目录</h2>
            <div className="mt-3 grid gap-1">
                {visibleHeadings.map((heading) => {
                    const isActive = heading.id === activeId;

                    return (
                        <a
                            key={`${heading.index}-${heading.text}`}
                            href={`#${heading.id}`}
                            aria-current={isActive ? 'location' : undefined}
                            style={{ paddingLeft: `${Math.max(heading.level - 2, 0) * 12 + 12}px` }}
                            className={cn(
                                'flex min-h-[36px] items-center truncate rounded-token-sm py-2 transition-colors duration-token-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                                isActive
                                    ? 'bg-accent-50 text-accent'
                                    : 'text-muted hover:bg-accent-50 hover:text-accent'
                            )}
                        >
                            {heading.text}
                        </a>
                    );
                })}
            </div>
        </nav>
    );
}
