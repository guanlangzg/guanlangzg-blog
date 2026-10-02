'use client';

import {
  Calendar,
  Clock3,
  Download,
  Edit2,
  Eye,
  History,
  Send,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { Article } from '@/app/types/article';
import { cn } from '@/lib/utils';
import {
  getArticleKindLabel,
  getArticleStatusLabel,
  isPublicArticleStatus,
} from '@/lib/article-metadata';
import { getArticleWorkflowSummary } from '@/lib/article-quality';

export interface ArticleCardProps {
  article: Article;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
  onExport: () => void;
  onTogglePublishState: () => void;
  isDeleting: boolean;
}

function countArticleWords(content: string): number {
  const cjkCount = content.match(/[\u4e00-\u9fff]/g)?.length || 0;
  const wordCount = content
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return cjkCount + wordCount;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

export function ArticleCard({
  article,
  onEdit,
  onHistory,
  onDelete,
  onExport,
  onTogglePublishState,
  isDeleting,
}: ArticleCardProps) {
  const wordCount = countArticleWords(article.content);
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 450));
  const status = article.status || 'published';
  const isPublic = isPublicArticleStatus(status);
  const classificationActionLabel = isPublic
    ? '标记为草稿'
    : '标记为已发布';
  const ClassificationActionIcon = isPublic ? Undo2 : Send;
  const workflowSummary = getArticleWorkflowSummary(article);
  const qualitySummaryLabel = workflowSummary.blockingChecks.length > 0
    ? `发布阻塞 ${workflowSummary.blockingChecks.length}`
    : workflowSummary.warningChecks.length > 0
      ? `发布建议 ${workflowSummary.warningChecks.length}`
      : isPublic
        ? '质量通过'
        : '可发布';
  const firstQualityIssue = workflowSummary.blockingChecks[0] || workflowSummary.warningChecks[0] || null;

  return (
    <div className="group relative overflow-hidden rounded-token-card border border-border bg-surface p-4 shadow-token-card transition-all hover:-translate-y-0.5 hover:border-accent-300 hover:bg-accent-50/40 hover:shadow-token-card-hover focus-within:border-accent-300 focus-within:ring-2 focus-within:ring-accent-100 active:translate-y-0">
      <span className="absolute inset-y-0 left-0 w-1 bg-accent opacity-0 transition-opacity duration-token-fast group-hover:opacity-100 group-focus-within:opacity-100" />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 rounded-token-card text-left focus-visible:outline-none"
          aria-label={`编辑文章：${article.title || '无标题'}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium text-fg transition-colors group-hover:text-accent">
              {article.title || '无标题'}
            </h3>
            <span className="rounded-token-badge bg-accent-50 px-2 py-1 text-xs text-accent">
              {getArticleKindLabel(article.kind)}
            </span>
            <span className={cn(
              'rounded-token-badge px-2 py-1 text-xs',
              status === 'draft'
                ? 'bg-warning-50 text-warning-600'
                : status === 'evergreen'
                  ? 'bg-success-50 text-success'
                  : 'bg-surface text-subtle'
            )}>
              {getArticleStatusLabel(status)}
            </span>
            {article.featured ? (
              <span className="rounded-token-badge bg-warm-50 px-2 py-1 text-xs text-muted">
                精选
              </span>
            ) : null}
            {!article.title ? (
              <span className="rounded-token-badge bg-warning-50 px-2 py-1 text-xs text-warning-600">
                未命名
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-1 text-sm text-muted">
            {article.description || '暂无描述'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-subtle">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {article.date || '未设置日期'}
            </span>
            <span className="flex items-center gap-1">
              <Clock3 className="w-3 h-3" />
              {readingMinutes} 分钟
            </span>
            <span>{formatDate(article.updatedAt)} 更新</span>
            {article.category ? <span>{article.category}</span> : null}
            {article.tags.length > 0 && (
              <span className="flex min-w-0 items-center gap-1">
                <Tag className="w-3 h-3 shrink-0" />
                <span className="truncate">{article.tags.join(', ')}</span>
              </span>
            )}
          </div>
          <div className="mt-2 inline-flex items-center gap-2 rounded-token-button border border-accent-200 bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent transition-colors group-hover:bg-accent-100">
            <Edit2 className="h-3.5 w-3.5" />
            选择编辑
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={cn(
              'rounded-token-badge border px-2 py-1 font-medium',
              workflowSummary.blockingChecks.length > 0
                ? 'border-error-light bg-error-50 text-error-600'
                : workflowSummary.warningChecks.length > 0
                  ? 'border-warning-light bg-warning-50 text-warning-600'
                  : 'border-success-light bg-success-50 text-success'
            )}>
              {qualitySummaryLabel}
            </span>
            {firstQualityIssue ? (
              <span className="min-w-0 truncate text-subtle">
                {firstQualityIssue.label}
              </span>
            ) : null}
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <button
            type="button"
            onClick={onTogglePublishState}
            className={cn(
              'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-token-card border px-2.5 py-2 text-xs font-medium transition-colors focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9',
              isPublic
                ? 'border-border bg-surface text-muted hover:bg-warning-50 hover:text-warning-600'
                : 'border-accent-200 bg-accent-50 text-accent-700 hover:bg-accent-100'
            )}
            aria-label={`${classificationActionLabel}（编辑分类）：${article.title || '无标题'}`}
            title="仅更改文章编辑分类，不会发布到或撤下 GitHub Pages"
          >
            <ClassificationActionIcon className="h-4 w-4" />
            <span>{classificationActionLabel}</span>
          </button>
          {article.slug && status !== 'draft' ? (
            <a
              href={`/posts/${article.slug}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
              title="预览公开页"
              aria-label={`预览公开文章：${article.title || '无标题'}`}
            >
              <Eye className="w-4 h-4" />
            </a>
          ) : null}
          <button
            onClick={onHistory}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
            title="文章历史"
            aria-label={`文章历史：${article.title || '无标题'}`}
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={onEdit}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
            title="编辑"
            aria-label={`编辑文章：${article.title || '无标题'}`}
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={onExport}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-success-50 hover:text-success focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
            title="导出"
            aria-label={`导出文章：${article.title || '无标题'}`}
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className={cn(
              'inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card transition-colors focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9',
              isDeleting
                ? 'bg-error-50 text-error-600'
                : 'text-subtle hover:bg-error-50 hover:text-error-600'
            )}
            title={isDeleting ? '确认删除？' : '删除'}
            aria-label={`${isDeleting ? '确认删除文章' : '删除文章'}：${article.title || '无标题'}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
