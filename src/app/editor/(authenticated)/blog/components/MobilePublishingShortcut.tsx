'use client';

import { cn } from '@/lib/utils';

export function MobilePublishingShortcut({
  blockingCount,
  descriptionLength,
  isDirty,
  isPersisted,
  onOpenDetails,
  statusLabel,
  tagCount,
  warningCount,
}: {
  blockingCount: number;
  descriptionLength: number;
  isDirty: boolean;
  isPersisted: boolean;
  onOpenDetails: () => void;
  statusLabel: string;
  tagCount: number;
  warningCount: number;
}) {
  const saveStatusLabel = !isPersisted
    ? '未入库'
    : isDirty
      ? '有改动'
      : '已保存';

  return (
    <section
      className="rounded-token-card border border-border bg-surface p-3 shadow-token-card xl:hidden"
      aria-labelledby="mobile-publishing-shortcut-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-accent">publish</p>
          <h2 id="mobile-publishing-shortcut-title" className="mt-1 text-base font-semibold text-fg">
            发布概览
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            先确认标题、描述、标签和公开路径，再继续写正文。
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-token-badge px-2 py-1 text-xs font-medium',
            blockingCount
              ? 'bg-error-50 text-error-600'
              : warningCount
                ? 'bg-warning-50 text-warning-600'
                : 'bg-success-50 text-success'
          )}
          aria-live="polite"
        >
          {blockingCount ? `${blockingCount} 阻塞` : warningCount ? `${warningCount} 建议` : '可发布'}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <MobilePublishingMetric label="保存" value={saveStatusLabel} muted={!isPersisted || isDirty} />
        <MobilePublishingMetric label="状态" value={statusLabel} />
        <MobilePublishingMetric label="标签" value={`${tagCount} 个`} muted={!tagCount} />
        <MobilePublishingMetric label="摘要" value={`${descriptionLength} 字`} muted={descriptionLength < 30 || descriptionLength > 120} />
      </dl>

      <button
        type="button"
        onClick={onOpenDetails}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-token-card border border-accent-200 bg-accent-50 px-3 text-sm font-medium text-accent transition hover:bg-accent-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        检查文章信息
      </button>
    </section>
  );
}

function MobilePublishingMetric({
  label,
  muted,
  value,
}: {
  label: string;
  muted?: boolean;
  value: string;
}) {
  return (
    <div className="rounded-token-card border border-border bg-background px-2 py-2">
      <dt className="font-mono text-[11px] text-subtle">{label}</dt>
      <dd className={cn('mt-1 truncate font-medium', muted ? 'text-warning-600' : 'text-fg')}>
        {value}
      </dd>
    </div>
  );
}
