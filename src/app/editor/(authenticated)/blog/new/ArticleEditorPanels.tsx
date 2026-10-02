'use client';

import type { ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Columns2,
  Edit3,
  Eye,
  FileText,
  Hash,
  ListTree,
  ShieldCheck,
} from 'lucide-react';
import { QUALITY_SEVERITY_LABELS } from '@/lib/article-metadata';
import type {
  ArticleQualityCheck,
  MarkdownHeading,
} from '@/lib/article-quality';
import { cn } from '@/lib/utils';

export type EditorMode = 'write' | 'split' | 'preview';

function formatDraftTime(timestamp: number | null): string {
  if (!timestamp) {
    return '尚未生成';
  }

  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ModeSwitch({
  value,
  onChange,
}: {
  value: EditorMode;
  onChange: (mode: EditorMode) => void;
}) {
  const modes: Array<{ value: EditorMode; label: string; icon: ReactNode }> = [
    { value: 'write', label: '写作', icon: <Edit3 className="h-4 w-4" /> },
    { value: 'split', label: '分栏', icon: <Columns2 className="h-4 w-4" /> },
    { value: 'preview', label: '预览', icon: <Eye className="h-4 w-4" /> },
  ];

  return (
    <div className="inline-flex w-full rounded-token-card border border-border bg-surface p-1 sm:w-auto">
      {modes.map((mode) => (
        <button
          key={mode.value}
          type="button"
          onClick={() => onChange(mode.value)}
          className={cn(
            'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-token-sm px-3 text-sm font-medium transition sm:min-h-8 sm:flex-none',
            value === mode.value
              ? 'bg-fg text-surface shadow-token-sm'
              : 'text-muted hover:bg-background hover:text-fg'
          )}
          aria-pressed={value === mode.value}
        >
          {mode.icon}
          <span>{mode.label}</span>
        </button>
      ))}
    </div>
  );
}

export function WritingInspector({
  wordCount,
  readingMinutes,
  headings,
  draftSavedAt,
  isDirty,
  isPersisted,
  templateName,
  qualityChecks,
  onJumpToHeading,
  onResolveCheck,
}: {
  wordCount: number;
  readingMinutes: number;
  headings: MarkdownHeading[];
  draftSavedAt: number | null;
  isDirty: boolean;
  isPersisted: boolean;
  templateName?: string;
  qualityChecks: ArticleQualityCheck[];
  onJumpToHeading: (heading: MarkdownHeading) => void;
  onResolveCheck?: (check: ArticleQualityCheck) => void;
}) {
  const failedBlocking = qualityChecks.filter((check) => check.severity === 'blocking' && !check.passed).length;
  const failedWarnings = qualityChecks.filter((check) => check.severity === 'warning' && !check.passed).length;
  const saveStatusLabel = !isPersisted
    ? '尚未保存到文章库'
    : isDirty
      ? '有未保存改动'
      : '内容已保存';

  return (
    <div className="space-y-4">
      <section className="rounded-token-card border border-border bg-surface p-4 shadow-token-card">
        <p className="font-mono text-xs text-accent">writing</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric icon={<Hash className="h-4 w-4" />} label="字数" value={wordCount.toString()} />
          <Metric icon={<Clock3 className="h-4 w-4" />} label="阅读" value={`${readingMinutes} 分钟`} />
        </div>
        <div className="mt-4 rounded-token-card border border-border bg-background p-3 text-sm text-muted">
          <div className="flex items-center gap-2">
            {!isPersisted || isDirty ? (
              <AlertCircle className="h-4 w-4 text-warning-600" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-success" />
            )}
            <span>{saveStatusLabel}</span>
          </div>
          <p className="mt-2 font-mono text-xs text-subtle">
            draft {formatDraftTime(draftSavedAt)}
          </p>
        </div>
      </section>

      <section className="rounded-token-card border border-border bg-surface p-4 shadow-token-card">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-subtle" />
          <h2 className="text-base font-semibold text-fg">写作检查</h2>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {templateName ? (
            <span className="rounded-token-badge border border-border bg-background px-2 py-1 text-subtle">
              {templateName}
            </span>
          ) : null}
          <span className="rounded-token-badge bg-error-50 px-2 py-1 text-error-600">
            {failedBlocking} 阻塞
          </span>
          <span className="rounded-token-badge bg-warning-50 px-2 py-1 text-warning-600">
            {failedWarnings} 建议
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {qualityChecks.slice(0, 10).map((check) => (
            <QualityCheckItem
              key={check.id}
              check={check}
              onResolve={onResolveCheck}
            />
          ))}
        </div>
      </section>

      <section className="rounded-token-card border border-border bg-surface p-4 shadow-token-card">
        <div className="flex items-center gap-2">
          <ListTree className="h-4 w-4 text-subtle" />
          <h2 className="text-base font-semibold text-fg">目录</h2>
        </div>
        {headings.length ? (
          <div className="mt-3 space-y-2 sm:space-y-1">
            {headings.slice(0, 12).map((heading) => (
              <button
                key={`${heading.index}-${heading.text}`}
                type="button"
                onClick={() => onJumpToHeading(heading)}
                className={cn(
                  'block min-h-11 w-full truncate rounded-token-sm px-2 py-2.5 text-left text-sm text-muted transition hover:bg-accent-50 hover:text-accent sm:min-h-9 sm:py-1.5',
                  heading.level === 2 ? 'pl-4' : heading.level === 3 ? 'pl-7' : heading.level === 4 ? 'pl-10' : ''
                )}
              >
                {heading.text}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-token-card border border-dashed border-border bg-background p-4 text-center text-sm text-subtle">
            <FileText className="mx-auto mb-2 h-5 w-5" />
            暂无标题
          </div>
        )}
      </section>
    </div>
  );
}

function QualityCheckItem({
  check,
  onResolve,
}: {
  check: ArticleQualityCheck;
  onResolve?: (check: ArticleQualityCheck) => void;
}) {
  const isActionable = !check.passed && Boolean(onResolve);
  const className = cn(
    'flex w-full items-start gap-2 rounded-token-card border px-3 py-2 text-left text-sm transition',
    check.passed
      ? 'border-success-light bg-success-50/60 text-success'
      : check.severity === 'blocking'
        ? 'border-error-200 bg-error-50 text-error-600'
        : 'border-warning-200 bg-warning-50 text-warning-600',
    isActionable
      ? 'cursor-pointer hover:-translate-y-px hover:shadow-token-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
      : ''
  );
  const content = (
    <>
      {check.passed ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      ) : check.severity === 'blocking' ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0">
        <p className="font-medium">{check.label}</p>
        <p className="font-mono text-[11px] opacity-75">
          {QUALITY_SEVERITY_LABELS[check.severity]}
          {isActionable ? ' / 点击定位' : ''}
        </p>
      </div>
    </>
  );

  if (!isActionable) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onResolve?.(check)}
      className={className}
    >
      {content}
    </button>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-token-card border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-subtle">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="mt-2 text-lg font-semibold text-fg">{value}</div>
    </div>
  );
}
