'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Download,
  Edit2,
  Edit3,
  FileText,
  Plus,
  Search,
  Sparkles,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import { useLocalArticles } from '@/app/hooks/useLocalArticles';
import { TemplateSelector } from './components/TemplateSelector';
import { ArticleCard } from './components/ArticleCard';
import { ArticleHistoryPanel } from '../../components/ArticleHistoryPanel';
import { AssetMetric } from './components/AssetMetric';
import { FilterPill } from './components/FilterPill';
import { WORKFLOW_TABS, WorkflowTab } from './components/WorkflowTab';
import { Article } from '@/app/types/article';
import { EmptyState, StatusMessage } from '@/app/components/ui';
import {
  ARTICLE_KIND_OPTIONS,
  ARTICLE_STATUS_OPTIONS,
} from '@/lib/article-metadata';
import { getArticleSaveBlockingChecks } from '@/lib/article-quality';
import {
  matchesArticleWorkflowState,
  type ArticleWorkflowState,
} from '@/lib/article-quality';
import { LogoutButton } from '../../components/LogoutButton';
import { EditorLoading } from '../../components/EditorLoading';
import {
  EditorButton,
  EditorMain,
  EditorPage,
  EditorTopBar,
} from '../../components/EditorShell';

export default function BlogEditorPage() {
  const router = useRouter();
  const {
    articles,
    deleteArticle,
    exportArticle,
    exportArticlesData,
    importArticle,
    isLoaded,
    lastConflictAt,
    lastRemoteLoadError,
    lastRemoteSaveError,
    updateArticle,
  } = useLocalArticles();
  const [showTemplates, setShowTemplates] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [historyArticleId, setHistoryArticleId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'danger' | 'info';
    text: string;
    action?: { label: string; articleId: string };
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState<ArticleWorkflowState | ''>('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [featuredFilter, setFeaturedFilter] = useState(false);
  const hasActiveFilters = Boolean(searchTerm.trim() || kindFilter || statusFilter || workflowFilter || categoryFilter || featuredFilter);
  const activeKindLabel = ARTICLE_KIND_OPTIONS.find((option) => option.value === kindFilter)?.label || kindFilter;
  const activeStatusLabel = ARTICLE_STATUS_OPTIONS.find((option) => option.value === statusFilter)?.label || statusFilter;
  const activeWorkflowLabel = WORKFLOW_TABS.find((option) => option.value === workflowFilter)?.label || workflowFilter;

  const sortedArticles = useMemo(
    () => [...articles].sort((first, second) => second.updatedAt - first.updatedAt),
    [articles]
  );
  const latestArticle = sortedArticles.find((article) => article.status === 'draft') || sortedArticles[0];
  const categories = useMemo(
    () => Array.from(new Set(articles.map((article) => article.category).filter(Boolean) as string[])).sort(),
    [articles]
  );
  const articleStats = useMemo(() => ({
    total: articles.length,
    drafts: articles.filter((article) => article.status === 'draft').length,
    evergreen: articles.filter((article) => article.status === 'evergreen').length,
    featured: articles.filter((article) => article.featured).length,
  }), [articles]);
  const workflowStats = useMemo(() => ({
    draft: articles.filter((article) => (article.status || 'published') === 'draft').length,
    needsFix: articles.filter((article) => matchesArticleWorkflowState(article, 'needs-fix')).length,
    ready: articles.filter((article) => matchesArticleWorkflowState(article, 'ready')).length,
    published: articles.filter((article) => matchesArticleWorkflowState(article, 'published')).length,
  }), [articles]);
  const filteredArticles = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return sortedArticles.filter((article) => {
      const haystack = [
        article.title,
        article.description,
        article.date,
        article.kind,
        article.status,
        article.category,
        article.series,
        article.tags.join(' '),
      ].join(' ').toLowerCase();

      return (
        (!keyword || haystack.includes(keyword)) &&
        (!workflowFilter || matchesArticleWorkflowState(article, workflowFilter)) &&
        (!kindFilter || article.kind === kindFilter) &&
        (!statusFilter || (article.status || 'published') === statusFilter) &&
        (!categoryFilter || article.category === categoryFilter) &&
        (!featuredFilter || article.featured)
      );
    });
  }, [categoryFilter, featuredFilter, kindFilter, searchTerm, sortedArticles, statusFilter, workflowFilter]);

  const handleClearFilters = useCallback(() => {
    setSearchTerm('');
    setKindFilter('');
    setStatusFilter('');
    setWorkflowFilter('');
    setCategoryFilter('');
    setFeaturedFilter(false);
  }, []);

  const handleSelectTemplate = useCallback((templateId: string) => {
    router.push(`/editor/blog/new?template=${templateId}`);
  }, [router]);

  const handleEdit = useCallback((articleId: string) => {
    router.push(`/editor/blog/new?edit=${articleId}`);
  }, [router]);

  const handleDelete = useCallback((articleId: string) => {
    if (deleteConfirm === articleId) {
      const deleted = deleteArticle(articleId);
      setDeleteConfirm(null);
      setMessage(deleted
        ? { tone: 'success', text: '文章已删除。' }
        : { tone: 'danger', text: '未找到要删除的文章。' });
    } else {
      setDeleteConfirm(articleId);
      setMessage({ tone: 'info', text: '再次点击删除按钮确认删除。' });
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  }, [deleteConfirm, deleteArticle]);

  const handleTogglePublishState = useCallback((article: Article) => {
    const status = article.status || 'published';

    if (status === 'draft') {
      const nextArticle: Article = { ...article, status: 'published' };
      const failedBlockingCheck = getArticleSaveBlockingChecks(nextArticle)[0];

      if (failedBlockingCheck) {
        setMessage({
          tone: 'danger',
          text: `标记为已发布（编辑分类）前需要处理：${failedBlockingCheck.label}。此操作不会发布到 Pages。`,
          action: { label: '去编辑', articleId: article.id },
        });
        return;
      }

      const updated = updateArticle(article.id, { status: 'published' });
      setMessage(updated
        ? { tone: 'success', text: '文章已标记为已发布（编辑分类）；此操作不会发布到 Pages。' }
        : { tone: 'danger', text: '未找到要标记为已发布（编辑分类）的文章。' });
      return;
    }

    const updated = updateArticle(article.id, { status: 'draft' });
    setMessage(updated
      ? { tone: 'success', text: '文章已标记为草稿（编辑分类）；此操作不会从 Pages 撤下内容。' }
      : { tone: 'danger', text: '未找到要标记为草稿（编辑分类）的文章。' });
  }, [updateArticle]);

  const handleExport = useCallback((article: Article) => {
    const markdown = exportArticle(article);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `${article.title || 'article'}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setMessage({ tone: 'success', text: '文章 Markdown 已导出。' });
  }, [exportArticle]);

  const handleExportAll = useCallback(() => {
    const json = exportArticlesData();
    const blob = new Blob([json], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = 'blog-articles.json';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setMessage({ tone: 'success', text: '全部文章 JSON 已导出。' });
  }, [exportArticlesData]);

  const handleImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    const handleReadError = () => {
      setMessage({ tone: 'danger', text: '文章文件读取失败，请重新选择 Markdown 文件。' });
    };

    reader.onload = (readerEvent) => {
      const content = typeof readerEvent.target?.result === 'string'
        ? readerEvent.target.result
        : '';

      if (!content.trim()) {
        setMessage({ tone: 'danger', text: '文章导入失败，请检查 Markdown frontmatter。' });
        return;
      }

      const imported = importArticle(content);
      setMessage(imported
        ? { tone: 'success', text: '文章已导入。' }
        : { tone: 'danger', text: '文章导入失败，请检查 Markdown frontmatter。' });
    };
    reader.onerror = handleReadError;
    reader.onabort = handleReadError;
    reader.readAsText(file);
    event.target.value = '';
  }, [importArticle]);

  if (!isLoaded) {
    return <EditorLoading />;
  }

  return (
    <EditorPage className="pb-12">
      <EditorTopBar
        title="博客管理"
        description={`共 ${articles.length} 篇文章`}
        eyebrow="editor.blog"
        backHref="/editor"
        width="xl"
        actions={(
          <>
            <LogoutButton />
            <EditorButton
              onClick={handleExportAll}
              disabled={articles.length === 0}
              aria-label="导出全部文章 JSON"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">导出</span>
            </EditorButton>
            <label
              className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-token-card border border-border bg-surface px-3 py-2 text-sm font-medium text-fg transition hover:border-border hover:bg-surface focus-within:ring-2 focus-within:ring-link focus-within:ring-offset-2 sm:min-h-10 sm:min-w-0"
              aria-label="导入文章 Markdown"
            >
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">导入</span>
              <input
                type="file"
                accept=".md,.markdown"
                onChange={handleImport}
                className="sr-only"
                aria-label="导入文章 Markdown"
              />
            </label>

            <EditorButton
              onClick={() => setShowTemplates((current) => !current)}
              variant="primary"
            >
              <Plus className="w-4 h-4" />
              新建文章
            </EditorButton>
          </>
        )}
      />

      <EditorMain width="xl" className="space-y-5">
        {lastConflictAt ? (
          <StatusMessage tone="warning">
            服务器上的文章数据更新较新，已载入服务器版本；请确认当前内容后继续编辑。
          </StatusMessage>
        ) : null}

        {lastRemoteLoadError ? (
          <StatusMessage tone="warning">
            文章从服务器加载失败，当前显示本机副本：{lastRemoteLoadError.message}
          </StatusMessage>
        ) : null}

        {lastRemoteSaveError ? (
          <StatusMessage tone="warning">
            文章已保存在本机，但同步到服务器失败：{lastRemoteSaveError.message}
          </StatusMessage>
        ) : null}

        {historyArticleId ? (
          <ArticleHistoryPanel
            articleId={historyArticleId}
            articleTitle={articles.find((article) => article.id === historyArticleId)?.title || '无标题'}
            onClose={() => setHistoryArticleId(null)}
          />
        ) : null}

        {message ? (
          <StatusMessage tone={message.tone}>
            <span>{message.text}</span>
            {message.action ? (
              <button
                type="button"
                onClick={() => {
                  if (message.action) {
                    handleEdit(message.action.articleId);
                  }
                }}
                className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-token-card border border-danger-light bg-surface px-3 text-sm font-medium text-error-600 transition hover:bg-error-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-9"
              >
                <Edit3 className="h-4 w-4" />
                {message.action.label}
              </button>
            ) : null}
          </StatusMessage>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="文章状态快速筛选">
          <AssetMetric
            label="总文章"
            value={articleStats.total}
            active={!statusFilter && !categoryFilter && !searchTerm.trim() && !kindFilter}
            onClick={handleClearFilters}
          />
          <AssetMetric
            label="草稿"
            value={articleStats.drafts}
            active={statusFilter === 'draft'}
            onClick={() => setStatusFilter(statusFilter === 'draft' ? '' : 'draft')}
          />
          <AssetMetric
            label="常青"
            value={articleStats.evergreen}
            active={statusFilter === 'evergreen'}
            onClick={() => setStatusFilter(statusFilter === 'evergreen' ? '' : 'evergreen')}
          />
          <AssetMetric
            label="精选"
            value={articleStats.featured}
            active={featuredFilter}
            onClick={() => setFeaturedFilter((current) => !current)}
          />
        </section>

        <section
          className="grid gap-2 rounded-token-card border border-border bg-surface p-2 shadow-token-card sm:grid-cols-4"
          aria-label="文章工作流视图"
        >
          {WORKFLOW_TABS.map((tab) => (
            <WorkflowTab
              key={tab.value}
              label={tab.label}
              description={tab.description}
              value={workflowStats[tab.statKey]}
              active={workflowFilter === tab.value}
              onClick={() => setWorkflowFilter((current) => current === tab.value ? '' : tab.value)}
            />
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-token-card border border-border bg-surface p-4 shadow-token-card">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-mono text-xs text-accent">compose</p>
                <h2 className="mt-1 text-xl font-semibold text-fg">开始一篇新文章</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                  模板已经按教程、源码、排障、发布记录等场景整理好，可以直接进入写作。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <EditorButton onClick={() => handleSelectTemplate('til')} variant="accent">
                  <Sparkles className="h-4 w-4" />
                  短笔记
                </EditorButton>
                <EditorButton onClick={() => handleSelectTemplate('tutorial')}>
                  <FileText className="h-4 w-4" />
                  正式文章
                </EditorButton>
                <EditorButton onClick={() => handleSelectTemplate('resource')}>
                  <Tag className="h-4 w-4" />
                  资源清单
                </EditorButton>
                <EditorButton onClick={() => handleSelectTemplate('blank')} variant="accent">
                  <FileText className="h-4 w-4" />
                  空白文章
                </EditorButton>
                <EditorButton onClick={() => setShowTemplates(true)}>
                  <Sparkles className="h-4 w-4" />
                  模板库
                </EditorButton>
              </div>
            </div>
          </div>

          <div className="rounded-token-card border border-border bg-surface p-4 shadow-token-card">
            <p className="font-mono text-xs text-accent">recent</p>
            {latestArticle ? (
              <>
                <h2 className="mt-1 truncate text-lg font-semibold text-fg">
                  {latestArticle.title || '无标题'}
                </h2>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted">
                  {latestArticle.description || '暂无描述'}
                </p>
                <button
                  type="button"
                  onClick={() => handleEdit(latestArticle.id)}
                  className="mt-4 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-token-card px-3 text-sm font-medium text-accent transition hover:bg-accent-50 hover:text-accent-800 sm:min-h-9 sm:min-w-0"
                >
                <Edit2 className="h-4 w-4" />
                继续编辑
                </button>
              </>
            ) : (
              <div className="mt-4 rounded-token-card border border-dashed border-border bg-background p-4 text-sm text-subtle">
                暂无最近文章
              </div>
            )}
          </div>
        </section>

        {(showTemplates || articles.length === 0) && (
          <section className="space-y-4 animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-accent">templates</p>
                <h2 className="mt-1 text-lg font-semibold text-fg">选择写作模板</h2>
              </div>
              {articles.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowTemplates(false)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card px-3 text-sm text-muted hover:bg-surface hover:text-fg sm:min-h-9 sm:min-w-0"
                >
                  收起
                </button>
              ) : null}
            </div>
            <TemplateSelector onSelect={handleSelectTemplate} compact />
          </section>
        )}

        <section className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="font-mono text-xs text-accent">articles</p>
              <h2 className="mt-1 text-lg font-semibold text-fg">文章列表</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="relative sm:col-span-2 lg:col-span-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  aria-label="搜索文章"
                  placeholder="搜索标题、描述或标签"
                  className="min-h-11 w-full rounded-token-card border border-border bg-surface py-2 pl-9 pr-3 text-sm text-fg outline-none transition focus:border-link focus:ring-2 focus:ring-link/20 sm:min-h-10"
                />
              </label>
              <select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
                className="min-h-11 rounded-token-card border border-border bg-surface px-3 py-2 text-sm text-fg outline-none transition focus:border-link focus:ring-2 focus:ring-link/20 sm:min-h-10"
                aria-label="按文章类型筛选"
              >
                <option value="">全部类型</option>
                {ARTICLE_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="min-h-11 rounded-token-card border border-border bg-surface px-3 py-2 text-sm text-fg outline-none transition focus:border-link focus:ring-2 focus:ring-link/20 sm:min-h-10"
                aria-label="按文章状态筛选"
              >
                <option value="">全部状态</option>
                {ARTICLE_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="min-h-11 rounded-token-card border border-border bg-surface px-3 py-2 text-sm text-fg outline-none transition focus:border-link focus:ring-2 focus:ring-link/20 sm:min-h-10"
                aria-label="按分类筛选"
              >
                <option value="">全部分类</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-token-card border border-border bg-surface px-3 py-2 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
            <p aria-live="polite">
              当前显示 <span className="font-semibold text-fg">{filteredArticles.length}</span> / {articles.length} 篇
            </p>
            {hasActiveFilters ? (
              <div className="flex flex-wrap items-center gap-2">
                {searchTerm.trim() ? (
                  <FilterPill label={`搜索：${searchTerm.trim()}`} onRemove={() => setSearchTerm('')} />
                ) : null}
                {kindFilter ? (
                  <FilterPill label={`类型：${activeKindLabel}`} onRemove={() => setKindFilter('')} />
                ) : null}
                {statusFilter ? (
                  <FilterPill label={`状态：${activeStatusLabel}`} onRemove={() => setStatusFilter('')} />
                ) : null}
                {workflowFilter ? (
                  <FilterPill label={`工作流：${activeWorkflowLabel}`} onRemove={() => setWorkflowFilter('')} />
                ) : null}
                {categoryFilter ? (
                  <FilterPill label={`分类：${categoryFilter}`} onRemove={() => setCategoryFilter('')} />
                ) : null}
                {featuredFilter ? (
                  <FilterPill label="仅精选" onRemove={() => setFeaturedFilter(false)} />
                ) : null}
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-token-card border border-border bg-background px-3 text-xs font-medium text-muted transition hover:border-accent-200 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-9"
                >
                  <X className="h-3.5 w-3.5" />
                  清除筛选
                </button>
              </div>
            ) : (
              <span className="font-mono text-xs text-subtle">未应用筛选</span>
            )}
          </div>

          <p className="text-xs text-muted">
            文章状态仅用于编辑分类，不代表 GitHub Pages 上线状态；此处不会发布到 Pages。
          </p>
          {filteredArticles.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={articles.length === 0 ? '还没有文章' : '没有匹配的文章'}
              description={articles.length === 0
                ? '选择一个模板或空白文章后，这里会显示你的写作列表。'
                : '当前筛选没有结果，清除筛选后可以回到完整文章列表。'}
              action={articles.length === 0 ? (
                <EditorButton onClick={() => setShowTemplates(true)} variant="accent">
                  <Plus className="h-4 w-4" />
                  新建文章
                </EditorButton>
              ) : (
                <EditorButton onClick={handleClearFilters}>
                  <X className="h-4 w-4" />
                  清除筛选
                </EditorButton>
              )}
            />
          ) : (
            <div className="space-y-3">
              {filteredArticles.map((article) => (
                <ArticleCard
                  key={article.id}
                  article={article}
                  onEdit={() => handleEdit(article.id)}
                  onHistory={() => setHistoryArticleId((current) => current === article.id ? null : article.id)}
                  onDelete={() => handleDelete(article.id)}
                  onExport={() => handleExport(article)}
                  onTogglePublishState={() => handleTogglePublishState(article)}
                  isDeleting={deleteConfirm === article.id}
                />
              ))}
            </div>
          )}
        </section>
      </EditorMain>
    </EditorPage>
  );
}
