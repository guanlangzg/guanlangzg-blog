'use client';

import { cn } from '@/lib/utils';
import type { ArticleWorkflowState } from '@/lib/article-quality';

export const WORKFLOW_TABS: Array<{
  value: ArticleWorkflowState;
  label: string;
  description: string;
  statKey: 'draft' | 'needsFix' | 'ready' | 'published';
}> = [
  {
    value: 'draft',
    label: '草稿',
    description: '全部未发布文章',
    statKey: 'draft',
  },
  {
    value: 'needs-fix',
    label: '待修复',
    description: '存在发布阻塞',
    statKey: 'needsFix',
  },
  {
    value: 'ready',
    label: '可发布',
    description: '阻塞检查通过',
    statKey: 'ready',
  },
  {
    value: 'published',
    label: '已发布',
    description: '公开可见内容',
    statKey: 'published',
  },
];

export function WorkflowTab({
  label,
  description,
  value,
  active,
  onClick,
}: {
  label: string;
  description: string;
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-16 items-center justify-between gap-3 rounded-token-card border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active
          ? 'border-accent-300 bg-accent-50 text-accent'
          : 'border-transparent bg-background text-muted hover:border-accent-200 hover:text-fg'
      )}
      aria-pressed={active}
    >
      <span className="min-w-0">
        <span className={cn('block text-sm font-semibold', active ? 'text-accent' : 'text-fg')}>
          {label}
        </span>
        <span className="mt-0.5 block truncate text-xs text-subtle">{description}</span>
      </span>
      <span className={cn('font-mono text-lg font-semibold', active ? 'text-accent' : 'text-fg')}>
        {value}
      </span>
    </button>
  );
}
