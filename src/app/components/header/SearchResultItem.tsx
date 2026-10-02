'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { CommandSearchResult } from './useCommandSearch';

export function getSearchResultId(index: number): string {
  return `command-search-result-${index}`;
}

export function SearchResultItem({
  result,
  id,
  isActive,
  onSelect,
  onMouseEnter,
}: {
  result: CommandSearchResult;
  id: string;
  isActive: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
}) {
  const label = result.type === 'post' ? '文章' : '链接';
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-sm font-medium text-fg transition-colors group-hover:text-accent">
          {result.title}
        </div>
        <span className="shrink-0 rounded-token-badge bg-surface px-1.5 py-0.5 text-[10px] font-mono text-subtle border border-border-soft">
          {label}
        </span>
      </div>
      {result.description && (
        <div className="mt-1 line-clamp-1 text-xs text-muted">
          {result.description}
        </div>
      )}
      {result.meta && (
        <div className="mt-1 text-[11px] font-mono text-subtle">
          {result.meta}
        </div>
      )}
    </>
  );

  const className = 'group block border-b border-border-soft px-4 py-3 transition-colors last:border-0 hover:bg-accent-50';

  if (result.external) {
    return (
      <a
        id={id}
        href={result.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onSelect}
        onMouseEnter={onMouseEnter}
        role="option"
        aria-selected={isActive}
        data-active={isActive ? 'true' : undefined}
        className={cn(className, isActive && 'bg-accent-50')}
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      id={id}
      href={result.href}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      role="option"
      aria-selected={isActive}
      data-active={isActive ? 'true' : undefined}
      className={cn(className, isActive && 'bg-accent-50')}
    >
      {content}
    </Link>
  );
}
