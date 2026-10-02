'use client';

import { Frontmatter } from '@/app/types/article';
import { editorInputClassName } from '../../../components/EditorShell';
import {
  ARTICLE_KIND_OPTIONS,
  ARTICLE_STATUS_OPTIONS,
  getArticleStatusLabel,
} from '@/lib/article-metadata';
import { normalizeSlugPart } from '@/lib/article-data';
import { isSafeExternalUrl } from '@/lib/url-safety';
import { cn } from '@/lib/utils';
import { useTagsText } from '@/app/hooks/useTagsText';
import type { ArticleQualityCheck } from '@/lib/article-quality';
import type { ArticleRevisionNote, ArticleSourceLink } from '@/app/types/article';

interface FrontmatterFormProps {
  value: Frontmatter;
  onChange: (value: Frontmatter) => void;
  qualityChecks?: Partial<Record<keyof Frontmatter, ArticleQualityCheck[]>>;
  className?: string;
}

export function FrontmatterForm({ value, onChange, qualityChecks = {}, className }: FrontmatterFormProps) {
  const handleChange = (field: keyof Frontmatter, fieldValue: Frontmatter[keyof Frontmatter]) => {
    onChange({ ...value, [field]: fieldValue });
  };

  const [tagsText, handleTagsTextChange] = useTagsText(
    value.tags,
    (tags) => handleChange('tags', tags)
  );

  const normalizedSlug = normalizeSlugPart(value.slug || value.title);
  const postPath = normalizedSlug ? `/posts/${normalizedSlug}` : '/posts/article-id';
  const canGenerateSlug = value.title.trim().length > 0;

  const handleGenerateSlug = () => {
    if (!canGenerateSlug) {
      return;
    }

    handleChange('slug', normalizeSlugPart(value.title));
  };

  const sourceLinks = value.sourceLinks || [];
  const revisionNotes = value.revisionNotes || [];

  const handleSourceLinkChange = (
    index: number,
    field: keyof ArticleSourceLink,
    fieldValue: string
  ) => {
    const nextLinks = sourceLinks.map((link, linkIndex) =>
      linkIndex === index ? { ...link, [field]: fieldValue } : link
    );

    handleChange('sourceLinks', nextLinks);
  };

  const handleRevisionNoteChange = (
    index: number,
    field: keyof ArticleRevisionNote,
    fieldValue: string
  ) => {
    const nextNotes = revisionNotes.map((note, noteIndex) =>
      noteIndex === index ? { ...note, [field]: fieldValue } : note
    );

    handleChange('revisionNotes', nextNotes);
  };
  const titleChecks = qualityChecks.title || [];
  const dateChecks = qualityChecks.date || [];
  const updatedDateChecks = qualityChecks.updatedDate || [];
  const descriptionChecks = qualityChecks.description || [];
  const tagsChecks = qualityChecks.tags || [];
  const categoryChecks = qualityChecks.category || [];
  const featuredChecks = qualityChecks.featured || [];

  return (
    <div className={`rounded-token-card border border-border bg-surface p-4 shadow-token-card ${className || ''}`}>
      <div className="mb-4">
        <p className="font-mono text-xs text-accent">frontmatter</p>
        <h2 className="mt-1 text-base font-semibold text-fg">文章信息</h2>
      </div>

      <PublishingSummary
        descriptionLength={value.description.trim().length}
        postPath={postPath}
        qualityChecks={qualityChecks}
        sourceLinks={sourceLinks}
        status={value.status}
        tagCount={value.tags.length}
      />

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label htmlFor="frontmatter-title" className="block text-xs font-mono text-muted mb-1">
            title
          </label>
          <input
            id="frontmatter-title"
            type="text"
            value={value.title}
            onChange={(e) => handleChange('title', e.target.value)}
            placeholder="文章标题"
            className={editorInputClassName}
            aria-describedby={titleChecks.length ? 'frontmatter-title-feedback' : undefined}
            aria-invalid={hasBlockingCheck(titleChecks)}
          />
          <FieldFeedback id="frontmatter-title-feedback" checks={titleChecks} />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="frontmatter-slug" className="block text-xs font-mono text-muted">
              slug
            </label>
            <button
              type="button"
              onClick={handleGenerateSlug}
              disabled={!canGenerateSlug}
              className="inline-flex min-h-11 items-center justify-center rounded-token-card border border-border bg-background px-3 text-xs font-medium text-muted transition hover:border-accent-200 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8"
            >
              从标题生成
            </button>
          </div>
          <input
            id="frontmatter-slug"
            type="text"
            value={value.slug || ''}
            onChange={(e) => handleChange('slug', e.target.value)}
            placeholder="stable-article-url"
            className={editorInputClassName}
            aria-describedby="frontmatter-slug-help"
          />
          <div
            id="frontmatter-slug-help"
            className="mt-1.5 rounded-token-card border border-border bg-background px-2 py-1.5 text-xs leading-5 text-subtle"
          >
            <span className="font-medium text-muted">公开路径：</span>
            <code className="break-all font-mono text-accent">{postPath}</code>
            <span className="mt-1 block">
              留空时保存会按标题和文章 ID 自动生成稳定 URL。
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <div>
            <label htmlFor="frontmatter-date" className="block text-xs font-mono text-muted mb-1">
              date
            </label>
            <input
              id="frontmatter-date"
              type="date"
              value={value.date}
              onChange={(e) => handleChange('date', e.target.value)}
              className={editorInputClassName}
              aria-describedby={dateChecks.length ? 'frontmatter-date-feedback' : undefined}
              aria-invalid={hasBlockingCheck(dateChecks)}
            />
            <FieldFeedback id="frontmatter-date-feedback" checks={dateChecks} />
          </div>

          <div>
            <label htmlFor="frontmatter-updated-date" className="block text-xs font-mono text-muted mb-1">
              updatedDate
            </label>
            <input
              id="frontmatter-updated-date"
              type="date"
              value={value.updatedDate || ''}
              onChange={(e) => handleChange('updatedDate', e.target.value)}
              className={editorInputClassName}
              aria-describedby={updatedDateChecks.length ? 'frontmatter-updated-date-feedback' : undefined}
              aria-invalid={hasBlockingCheck(updatedDateChecks)}
            />
            <FieldFeedback id="frontmatter-updated-date-feedback" checks={updatedDateChecks} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <div>
            <label htmlFor="frontmatter-kind" className="block text-xs font-mono text-muted mb-1">
              kind
            </label>
            <select
              id="frontmatter-kind"
              value={value.kind || 'essay'}
              onChange={(e) => handleChange('kind', e.target.value as Frontmatter['kind'])}
              className={editorInputClassName}
            >
              {ARTICLE_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="frontmatter-status" className="block text-xs font-mono text-muted mb-1">
              status
            </label>
            <select
              id="frontmatter-status"
              value={value.status || 'draft'}
              onChange={(e) => handleChange('status', e.target.value as Frontmatter['status'])}
              className={editorInputClassName}
            >
              {ARTICLE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <div>
            <label htmlFor="frontmatter-category" className="block text-xs font-mono text-muted mb-1">
              category
            </label>
            <input
              id="frontmatter-category"
              type="text"
              value={value.category || ''}
              onChange={(e) => handleChange('category', e.target.value)}
              placeholder="工程实践"
              className={editorInputClassName}
              aria-describedby={categoryChecks.length ? 'frontmatter-category-feedback' : undefined}
              aria-invalid={hasBlockingCheck(categoryChecks)}
            />
            <FieldFeedback id="frontmatter-category-feedback" checks={categoryChecks} />
          </div>

          <div>
            <label htmlFor="frontmatter-series" className="block text-xs font-mono text-muted mb-1">
              series
            </label>
            <input
              id="frontmatter-series"
              type="text"
              value={value.series || ''}
              onChange={(e) => handleChange('series', e.target.value)}
              placeholder="可选系列名称"
              className={editorInputClassName}
            />
          </div>
        </div>

        <label className="flex items-center justify-between gap-3 rounded-token-card border border-border bg-background p-3 text-sm">
          <span>
            <span className="block font-medium text-fg">精选入口</span>
            <span className="block text-xs text-subtle">适合进入首页或归档精选区</span>
          </span>
          <input
            id="frontmatter-featured"
            type="checkbox"
            checked={Boolean(value.featured)}
            onChange={(e) => handleChange('featured', e.target.checked)}
            className="h-4 w-4 rounded border-border text-accent focus:ring-link"
            aria-describedby={featuredChecks.length ? 'frontmatter-featured-feedback' : undefined}
            aria-invalid={hasBlockingCheck(featuredChecks)}
          />
        </label>
        <FieldFeedback id="frontmatter-featured-feedback" checks={featuredChecks} />

        <div>
          <label htmlFor="frontmatter-tags" className="block text-xs font-mono text-muted mb-1">
            tags
          </label>
          <input
            id="frontmatter-tags"
            type="text"
            value={tagsText}
            onChange={(e) => handleTagsTextChange(e.target.value)}
            placeholder="标签1, 标签2, 标签3"
            className={editorInputClassName}
            aria-describedby={tagsChecks.length ? 'frontmatter-tags-feedback' : undefined}
            aria-invalid={hasBlockingCheck(tagsChecks)}
          />
          <FieldFeedback id="frontmatter-tags-feedback" checks={tagsChecks} />
        </div>

        <div>
          <label htmlFor="frontmatter-description" className="block text-xs font-mono text-muted mb-1">
            description
          </label>
          <textarea
            id="frontmatter-description"
            value={value.description}
            onChange={(e) => handleChange('description', e.target.value)}
            placeholder="文章描述"
            rows={2}
            className={`${editorInputClassName} resize-none`}
            aria-describedby={descriptionChecks.length ? 'frontmatter-description-feedback' : undefined}
            aria-invalid={hasBlockingCheck(descriptionChecks)}
          />
          <FieldFeedback id="frontmatter-description-feedback" checks={descriptionChecks} />
        </div>

        <div className="space-y-3 rounded-token-card border border-border bg-background p-3">
          <RepeatableSectionHeader
            title="参考资料"
            description="公开文章页会显示这些来源链接。"
            actionLabel="添加资料"
            onAdd={() => handleChange('sourceLinks', [...sourceLinks, { title: '', url: '', note: '' }])}
          />
          {sourceLinks.length ? (
            <div className="space-y-3">
              {sourceLinks.map((link, index) => (
                <div key={`source-${index}`} className="space-y-2 rounded-token-card border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs text-subtle">source {index + 1}</p>
                    <button
                      type="button"
                      onClick={() => handleChange('sourceLinks', sourceLinks.filter((_, linkIndex) => linkIndex !== index))}
                      className="inline-flex min-h-11 items-center rounded-token-card px-3 text-xs font-medium text-error-600 transition hover:bg-error-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8"
                    >
                      删除资料
                    </button>
                  </div>
                  <div className="grid gap-2">
                    <LabeledTextInput
                      id={`frontmatter-source-title-${index}`}
                      label="标题"
                      value={link.title}
                      onChange={(nextValue) => handleSourceLinkChange(index, 'title', nextValue)}
                      placeholder="官方文档"
                    />
                    <LabeledTextInput
                      id={`frontmatter-source-url-${index}`}
                      label="URL"
                      value={link.url}
                      onChange={(nextValue) => handleSourceLinkChange(index, 'url', nextValue)}
                      placeholder="https://example.com"
                      error={getSourceUrlError(link.url)}
                      helpText="生产环境只接受 HTTPS 链接。"
                      type="url"
                    />
                    <LabeledTextInput
                      id={`frontmatter-source-note-${index}`}
                      label="备注"
                      value={link.note || ''}
                      onChange={(nextValue) => handleSourceLinkChange(index, 'note', nextValue)}
                      placeholder="可选说明"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyRepeatableHint text="还没有参考资料。" />
          )}
        </div>

        <div className="space-y-3 rounded-token-card border border-border bg-background p-3">
          <RepeatableSectionHeader
            title="修订记录"
            description="公开文章页会显示这些更新说明。"
            actionLabel="添加修订"
            onAdd={() => handleChange('revisionNotes', [...revisionNotes, { date: value.updatedDate || value.date, note: '' }])}
          />
          {revisionNotes.length ? (
            <div className="space-y-3">
              {revisionNotes.map((revision, index) => (
                <div key={`revision-${index}`} className="space-y-2 rounded-token-card border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs text-subtle">revision {index + 1}</p>
                    <button
                      type="button"
                      onClick={() => handleChange('revisionNotes', revisionNotes.filter((_, noteIndex) => noteIndex !== index))}
                      className="inline-flex min-h-11 items-center rounded-token-card px-3 text-xs font-medium text-error-600 transition hover:bg-error-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8"
                    >
                      删除修订
                    </button>
                  </div>
                  <div className="grid gap-2">
                    <div>
                      <label htmlFor={`frontmatter-revision-date-${index}`} className="mb-1 block text-xs font-mono text-muted">
                        日期
                      </label>
                      <input
                        id={`frontmatter-revision-date-${index}`}
                        type="date"
                        value={revision.date}
                        onChange={(event) => handleRevisionNoteChange(index, 'date', event.target.value)}
                        className={editorInputClassName}
                      />
                    </div>
                    <LabeledTextInput
                      id={`frontmatter-revision-note-${index}`}
                      label="说明"
                      value={revision.note}
                      onChange={(nextValue) => handleRevisionNoteChange(index, 'note', nextValue)}
                      placeholder="补充验证记录"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyRepeatableHint text="还没有修订记录。" />
          )}
        </div>
      </div>
    </div>
  );
}

function RepeatableSectionHeader({
  title,
  description,
  actionLabel,
  onAdd,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-subtle">{description}</p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex min-h-11 shrink-0 items-center rounded-token-card border border-border bg-surface px-3 text-xs font-medium text-muted transition hover:border-accent-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function PublishingSummary({
  descriptionLength,
  postPath,
  qualityChecks,
  sourceLinks,
  status,
  tagCount,
}: {
  descriptionLength: number;
  postPath: string;
  qualityChecks: Partial<Record<keyof Frontmatter, ArticleQualityCheck[]>>;
  sourceLinks: ArticleSourceLink[];
  status?: Frontmatter['status'];
  tagCount: number;
}) {
  const failedChecks = Object.values(qualityChecks).flat().filter((check) => !check.passed);
  const blockingCount = failedChecks.filter((check) => check.severity === 'blocking').length;
  const warningCount = failedChecks.filter((check) => check.severity === 'warning').length;
  const hasUnsafeSource = sourceLinks.some((source) => {
    const url = source.url.trim();

    return Boolean(url) && !isSafeExternalUrl(url);
  });
  const safeSourceCount = sourceLinks.filter((source) => {
    const url = source.url.trim();

    return Boolean(source.title.trim()) && Boolean(url) && isSafeExternalUrl(url);
  }).length;

  return (
    <section className="mb-4 rounded-token-card border border-border bg-background p-3" aria-labelledby="publishing-summary-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="publishing-summary-title" className="text-sm font-semibold text-fg">
            发布准备
          </h3>
          <p className="mt-1 text-xs leading-5 text-subtle">
            状态、路径和摘要会影响公开页展示。
          </p>
        </div>
        <span className={cn(
          'rounded-token-badge px-2 py-1 text-xs font-medium',
          blockingCount
            ? 'bg-error-50 text-error-600'
            : warningCount
              ? 'bg-warning-50 text-warning-600'
              : 'bg-success-50 text-success'
        )}>
          {blockingCount ? `${blockingCount} 阻塞` : warningCount ? `${warningCount} 建议` : '可发布'}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <SummaryItem label="状态" value={getArticleStatusLabel(status)} />
        <SummaryItem label="标签" value={`${tagCount} 个`} tone={tagCount ? 'default' : 'warning'} />
        <SummaryItem
          label="摘要"
          value={`${descriptionLength} 字`}
          tone={descriptionLength >= 30 && descriptionLength <= 120 ? 'default' : 'warning'}
        />
        <SummaryItem
          label="参考"
          value={hasUnsafeSource ? '需修正' : `${safeSourceCount} 条`}
          tone={hasUnsafeSource ? 'danger' : 'default'}
        />
      </dl>

      <div className="mt-3 rounded-token-card border border-border bg-surface px-2 py-1.5 text-xs leading-5 text-subtle">
        <span className="font-medium text-muted">公开路径：</span>
        <code className="break-all font-mono text-accent">{postPath}</code>
      </div>
    </section>
  );
}

function SummaryItem({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <div className="rounded-token-card border border-border bg-surface px-2 py-2">
      <dt className="font-mono text-[11px] text-subtle">{label}</dt>
      <dd className={cn(
        'mt-1 font-medium',
        tone === 'danger' ? 'text-error-600' : tone === 'warning' ? 'text-warning-600' : 'text-fg'
      )}>
        {value}
      </dd>
    </div>
  );
}

function LabeledTextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  error,
  helpText,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error?: string | null;
  helpText?: string;
  type?: 'text' | 'url';
}) {
  const descriptionId = error || helpText ? `${id}-description` : undefined;
  const isUrl = type === 'url';

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-mono text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        inputMode={isUrl ? 'url' : undefined}
        autoCapitalize={isUrl ? 'none' : undefined}
        autoCorrect={isUrl ? 'off' : undefined}
        spellCheck={isUrl ? false : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={editorInputClassName}
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
      />
      {error || helpText ? (
        <p
          id={descriptionId}
          className={cn(
            'mt-1 text-xs leading-5',
            error ? 'text-error-600' : 'text-subtle'
          )}
          role={error ? 'alert' : undefined}
        >
          {error || helpText}
        </p>
      ) : null}
    </div>
  );
}

function getSourceUrlError(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return isSafeExternalUrl(trimmed) ? null : '请输入有效的 HTTPS 链接。';
}

function EmptyRepeatableHint({ text }: { text: string }) {
  return (
    <div className="rounded-token-card border border-dashed border-border bg-surface px-3 py-4 text-center text-xs text-subtle">
      {text}
    </div>
  );
}

function hasBlockingCheck(checks: ArticleQualityCheck[]): boolean {
  return checks.some((check) => check.severity === 'blocking');
}

function FieldFeedback({ id, checks }: { id: string; checks: ArticleQualityCheck[] }) {
  if (!checks.length) {
    return null;
  }

  return (
    <div id={id} className="mt-1.5 space-y-1" aria-live="polite">
      {checks.map((check) => (
        <p
          key={check.id}
          className={cn(
            'rounded-token-card border px-2 py-1 text-xs leading-5',
            check.severity === 'blocking'
              ? 'border-error-200 bg-error-50 text-error-600'
              : 'border-warning-200 bg-warning-50 text-warning-600'
          )}
        >
          {check.severity === 'blocking' ? '发布阻塞：' : '发布建议：'}{getFieldFeedbackText(check)}
        </p>
      ))}
    </div>
  );
}

function getFieldFeedbackText(check: ArticleQualityCheck): string {
  const messageByCheckId: Record<string, string> = {
    'title-required': '请填写标题',
    'date-valid': '请选择有效日期',
    'published-description': '公开文章需要补充描述',
    'description-length': '描述建议控制在 30-120 字',
    'tags-present': '至少添加 1 个标签',
    'category-present': '设置一个主分类，便于归档',
    'featured-public': '精选内容需要先发布或设为常青',
    'evergreen-updated-date': '常青文章需要补充修订日期',
  };

  return messageByCheckId[check.id] || check.label;
}
