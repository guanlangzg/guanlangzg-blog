'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Save,
} from 'lucide-react';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { PreviewPane } from '../components/PreviewPane';
import { FrontmatterForm } from '../components/FrontmatterForm';
import { useLocalArticles } from '@/app/hooks/useLocalArticles';
import { getDefaultTemplate, getTemplateById } from '@/lib/templates';
import { Frontmatter } from '@/app/types/article';
import { StatusMessage } from '@/app/components/ui';
import { cn } from '@/lib/utils';
import { getArticleKindLabel, getArticleStatusLabel } from '@/lib/article-metadata';
import {
  countMarkdownWords,
  getArticleSaveBlockingChecks,
  getArticleQualityField,
  getFrontmatterFieldQualityChecks,
  getArticleQualityChecks,
  getMarkdownHeadings,
  type ArticleQualityCheck,
  type ArticleQualityField,
  type MarkdownHeading,
} from '@/lib/article-quality';
import {
  ModeSwitch,
  WritingInspector,
  type EditorMode,
} from './ArticleEditorPanels';
import { LogoutButton } from '../../../components/LogoutButton';
import { EditorLoading } from '../../../components/EditorLoading';
import {
  EditorButton,
  EditorMain,
  EditorPage,
  EditorTopBar,
} from '../../../components/EditorShell';
import {
  clearStoredDraft,
  getArticleDraftKey,
  readStoredDraft,
  writeStoredDraft,
} from '@/lib/article-draft-storage';
import {
  createArticleSnapshot,
  getTodayString,
  normalizeFrontmatter,
} from '@/lib/article-frontmatter';
import { isSafeExternalUrl } from '@/lib/url-safety';
import { MobilePublishingShortcut } from '../components/MobilePublishingShortcut';
import { createEditorCsrfHeaders } from '@/app/editor/editor-csrf';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UploadedMediaAsset {
  publicPath: string;
}

interface MediaUploadResponse {
  asset?: UploadedMediaAsset;
}

const TEXTAREA_ID = 'article-markdown-editor';
const QUALITY_FIELD_INPUT_IDS: Partial<Record<ArticleQualityField, string>> = {
  title: 'frontmatter-title',
  date: 'frontmatter-date',
  updatedDate: 'frontmatter-updated-date',
  description: 'frontmatter-description',
  tags: 'frontmatter-tags',
  category: 'frontmatter-category',
  status: 'frontmatter-status',
  featured: 'frontmatter-featured',
};

function isUploadedMediaAsset(value: unknown): value is UploadedMediaAsset {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as UploadedMediaAsset).publicPath === 'string'
  );
}

function createImageAltText(file: File): string {
  return file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim() || '图片';
}

export function NewArticleContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const templateId = searchParams.get('template');
  const editId = searchParams.get('edit');
  const articleKey = editId ? `edit:${editId}` : `new:${templateId || 'blank'}`;
  const draftKey = getArticleDraftKey(articleKey);

  const {
    createArticle,
    updateArticleContent,
    getArticleById,
    exportArticle,
    isLoaded,
    lastConflictAt,
    lastRemoteLoadError,
    lastRemoteSaveError,
  } = useLocalArticles();

  const [content, setContent] = useState('');
  const [frontmatter, setFrontmatter] = useState<Frontmatter>({
    title: '',
    date: getTodayString(),
    description: '',
    kind: 'essay',
    status: 'draft',
    category: '',
    featured: false,
    tags: [],
  });
  const [editorMode, setEditorMode] = useState<EditorMode>('split');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [statusMessage, setStatusMessage] = useState<{
    tone: 'info' | 'success' | 'warning' | 'danger';
    text: string;
    blockingCheck?: ArticleQualityCheck;
  } | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [loadedArticleKey, setLoadedArticleKey] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const hasSelectedInitialMode = useRef(false);
  const deferredContent = useDeferredValue(content);
  // Remembers which article this draft URL already created so a repeated save
  // (for example a held shortcut) updates it instead of creating a duplicate.
  const createdArticleRef = useRef<{ draftKey: string; articleId: string } | null>(null);
  const saveStateTimerRef = useRef<number | null>(null);
  const draftRef = useRef({ draftKey, loadedArticleKey, content, frontmatter, savedSnapshot });

  const currentSnapshot = useMemo(() => createArticleSnapshot(frontmatter, content), [content, frontmatter]);
  const isDirty = Boolean(savedSnapshot && currentSnapshot !== savedSnapshot);
  const wordCount = useMemo(() => countMarkdownWords(content), [content]);
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 450));
  const headings = useMemo(() => getMarkdownHeadings(content), [content]);
  const editingArticle = editId ? getArticleById(editId) : undefined;
  const activeTemplate = useMemo(
    () => getTemplateById(frontmatter.templateId || templateId || '') || undefined,
    [frontmatter.templateId, templateId]
  );
  const qualityChecks = useMemo(
    () => getArticleQualityChecks({ ...frontmatter, content, sourceLinks: frontmatter.sourceLinks }, activeTemplate),
    [activeTemplate, content, frontmatter]
  );
  const failedBlockingCount = qualityChecks.filter((check) => check.severity === 'blocking' && !check.passed).length;
  const failedWarningCount = qualityChecks.filter((check) => check.severity === 'warning' && !check.passed).length;
  const frontmatterQualityChecks = useMemo(
    () => getFrontmatterFieldQualityChecks(qualityChecks),
    [qualityChecks]
  );
  const missingArticle = Boolean(editId && isLoaded && loadedArticleKey === articleKey && !editingArticle);
  const hasPersistedArticle = Boolean(editId && editingArticle);

  useEffect(() => {
    if (hasSelectedInitialMode.current) {
      return;
    }

    hasSelectedInitialMode.current = true;

    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches) {
      setEditorMode('write');
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || loadedArticleKey === articleKey) {
      return;
    }

    let nextContent = '';
    let nextFrontmatter: Frontmatter = {
      title: '',
      date: getTodayString(),
      description: '',
      kind: 'essay',
      status: 'draft',
      category: '',
      featured: false,
      tags: [],
    };

    if (editId) {
      const article = getArticleById(editId);

      if (!article) {
        setLoadedArticleKey(articleKey);
        return;
      }

      nextContent = article.content;
      nextFrontmatter = {
        title: article.title,
        slug: article.slug,
        date: article.date,
        updatedDate: article.updatedDate,
        description: article.description,
        kind: article.kind || 'essay',
        status: article.status || 'published',
        category: article.category || '',
        series: article.series || '',
        featured: Boolean(article.featured),
        tags: article.tags,
        sourceLinks: article.sourceLinks || [],
        revisionNotes: article.revisionNotes || [],
        templateId: article.templateId,
      };
    } else {
      const template = getTemplateById(templateId || 'blank') || getDefaultTemplate();

      nextContent = template.content;
      nextFrontmatter = {
        ...template.frontmatter,
        date: getTodayString(),
        updatedDate: template.defaultStatus === 'evergreen' ? getTodayString() : template.frontmatter.updatedDate,
        kind: template.kind || template.frontmatter.kind || 'essay',
        status: template.defaultStatus || template.frontmatter.status || 'draft',
        category: template.frontmatter.category || '',
        featured: Boolean(template.frontmatter.featured),
        templateId: template.id,
      };
    }

    const draft = readStoredDraft(draftKey);

    if (draft) {
      nextContent = draft.content;
      nextFrontmatter = draft.frontmatter;
      setDraftSavedAt(draft.updatedAt);
      setStatusMessage({ tone: 'info', text: '已恢复本机草稿。' });
    } else {
      setDraftSavedAt(null);
    }

    setContent(nextContent);
    setFrontmatter(nextFrontmatter);
    setSavedSnapshot(createArticleSnapshot(nextFrontmatter, nextContent));
    setLoadedArticleKey(articleKey);
    setSaveState('idle');
  }, [articleKey, draftKey, editId, getArticleById, isLoaded, loadedArticleKey, templateId]);

  useEffect(() => {
    draftRef.current = { draftKey, loadedArticleKey, content, frontmatter, savedSnapshot };
  });

  // This page component stays mounted when the route switches from the blank draft URL to its
  // `?edit=<id>` URL, so the ref must not outlive the route that created it: returning to the blank
  // URL is a new article, not a continuation of the one that URL previously created.
  useEffect(() => {
    createdArticleRef.current = null;
  }, [articleKey]);

  useEffect(() => {
    const flushDraft = () => {
      const latest = draftRef.current;

      if (!latest.loadedArticleKey) {
        return;
      }

      if (createArticleSnapshot(latest.frontmatter, latest.content) === latest.savedSnapshot) {
        return;
      }

      writeStoredDraft(latest.draftKey, latest.frontmatter, latest.content);
    };

    // pagehide covers tab close/reload before the debounce fires; the cleanup
    // covers leaving the editor through client navigation.
    window.addEventListener('pagehide', flushDraft);

    return () => {
      window.removeEventListener('pagehide', flushDraft);
      flushDraft();
    };
  }, []);

  useEffect(() => () => {
    if (saveStateTimerRef.current !== null) {
      window.clearTimeout(saveStateTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isDirty || loadedArticleKey !== articleKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const updatedAt = writeStoredDraft(draftKey, frontmatter, content);

      if (updatedAt) {
        setDraftSavedAt(updatedAt);
      }
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [articleKey, content, draftKey, frontmatter, isDirty, loadedArticleKey]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (isDirty && saveState === 'saved') {
      setSaveState('idle');
    }
  }, [isDirty, saveState]);

  const focusElementById = useCallback((elementId: string) => {
    window.requestAnimationFrame(() => {
      const element = document.getElementById(elementId);

      if (!element) {
        return;
      }

      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
      }
    });
  }, []);

  const handleResolveQualityCheck = useCallback((check: ArticleQualityCheck) => {
    const field = getArticleQualityField(check.id);

    if (field === 'sourceLinks') {
      const invalidSourceIndex = frontmatter.sourceLinks?.findIndex((source) => {
        const url = source.url.trim();

        return Boolean(url) && !isSafeExternalUrl(url);
      }) ?? -1;

      focusElementById(`frontmatter-source-url-${Math.max(0, invalidSourceIndex)}`);
      return;
    }

    const fieldInputId = field ? QUALITY_FIELD_INPUT_IDS[field] : undefined;

    if (fieldInputId) {
      focusElementById(fieldInputId);
      return;
    }

    if (field === 'content') {
      if (editorMode === 'preview') {
        setEditorMode('split');
      }

      focusElementById(TEXTAREA_ID);
    }
  }, [editorMode, focusElementById, frontmatter.sourceLinks]);

  const handleSave = useCallback(async () => {
    const failedBlockingCheck = getArticleSaveBlockingChecks(
      { ...frontmatter, content },
      activeTemplate
    )[0];

    if (failedBlockingCheck) {
      setSaveState('error');
      setStatusMessage({
        tone: 'danger',
        text: `保存前需要处理：${failedBlockingCheck.label}。`,
        blockingCheck: failedBlockingCheck,
      });
      handleResolveQualityCheck(failedBlockingCheck);
      return;
    }

    const normalizedFrontmatter = normalizeFrontmatter(frontmatter);
    const nextSnapshot = createArticleSnapshot(normalizedFrontmatter, content);

    setSaveState('saving');
    setStatusMessage(null);

    try {
      const createdArticleId = createdArticleRef.current?.draftKey === draftKey
        ? createdArticleRef.current.articleId
        : null;
      const targetArticleId = editId || createdArticleId;
      const updated = targetArticleId
        ? updateArticleContent(targetArticleId, normalizedFrontmatter, content)
        : null;
      let savedArticleId = targetArticleId;

      if (!updated) {
        if (editId) {
          throw new Error('article_not_found');
        }

        const created = createArticle(normalizedFrontmatter, content);
        savedArticleId = created.id;
        createdArticleRef.current = { draftKey, articleId: created.id };
      }

      setFrontmatter(normalizedFrontmatter);
      setSavedSnapshot(nextSnapshot);
      clearStoredDraft(draftKey);
      setDraftSavedAt(null);
      // Keep an unload flush from restoring the draft that was just saved away.
      draftRef.current = {
        draftKey,
        loadedArticleKey: articleKey,
        content,
        frontmatter: normalizedFrontmatter,
        savedSnapshot: nextSnapshot,
      };
      setSaveState('saved');
      setStatusMessage({ tone: 'success', text: '文章已保存。' });

      if (!editId && savedArticleId) {
        router.replace(`/editor/blog/new?edit=${savedArticleId}`);
      }

      if (saveStateTimerRef.current !== null) {
        window.clearTimeout(saveStateTimerRef.current);
      }

      saveStateTimerRef.current = window.setTimeout(() => setSaveState('idle'), 1800);
    } catch (error) {
      console.error('Save failed:', error);
      setSaveState('error');
      setStatusMessage({ tone: 'danger', text: '保存失败，请稍后重试。' });
    }
  }, [activeTemplate, articleKey, content, createArticle, draftKey, editId, frontmatter, handleResolveQualityCheck, router, updateArticleContent]);

  const handleExport = useCallback(() => {
    const normalizedFrontmatter = normalizeFrontmatter(frontmatter);
    const article = {
      id: editId || 'new',
      title: normalizedFrontmatter.title,
      slug: normalizedFrontmatter.slug,
      date: normalizedFrontmatter.date,
      updatedDate: normalizedFrontmatter.updatedDate,
      description: normalizedFrontmatter.description,
      kind: normalizedFrontmatter.kind,
      status: normalizedFrontmatter.status,
      category: normalizedFrontmatter.category,
      series: normalizedFrontmatter.series,
      featured: normalizedFrontmatter.featured,
      tags: normalizedFrontmatter.tags,
      sourceLinks: normalizedFrontmatter.sourceLinks,
      revisionNotes: normalizedFrontmatter.revisionNotes,
      templateId: normalizedFrontmatter.templateId,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const markdown = exportArticle(article);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `${normalizedFrontmatter.title || 'article'}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [content, editId, exportArticle, frontmatter]);

  const handleUploadPastedImage = useCallback(async (file: File): Promise<string> => {
    const form = new FormData();

    form.set('file', file);
    setStatusMessage({ tone: 'info', text: '正在上传剪切板图片...' });

    const response = await fetch('/api/data/media', {
      method: 'POST',
      credentials: 'include',
      headers: createEditorCsrfHeaders(),
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as MediaUploadResponse & { message?: unknown };

    if (!response.ok) {
      const message = typeof payload?.message === 'string'
        ? payload.message
        : `图片上传失败（HTTP ${response.status}）。`;

      setStatusMessage({ tone: 'danger', text: message });
      throw new Error(message);
    }

    if (!isUploadedMediaAsset(payload?.asset)) {
      const message = '服务器返回的图片上传结果格式无效。';

      setStatusMessage({ tone: 'danger', text: message });
      throw new Error(message);
    }

    setStatusMessage({ tone: 'success', text: '图片已上传。' });

    return `![${createImageAltText(file)}](${payload.asset.publicPath})`;
  }, []);

  const handleJumpToHeading = useCallback((heading: MarkdownHeading) => {
    if (editorMode === 'preview') {
      setEditorMode('split');
    }

    window.requestAnimationFrame(() => {
      const textarea = document.getElementById(TEXTAREA_ID) as HTMLTextAreaElement | null;

      if (!textarea) {
        return;
      }

      const line = content.slice(0, heading.index).split('\n').length;
      const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 22;

      textarea.focus();
      textarea.setSelectionRange(heading.index, heading.index);
      textarea.scrollTop = Math.max(0, (line - 4) * lineHeight);
    });
  }, [content, editorMode]);

  if (!isLoaded) {
    return <EditorLoading />;
  }

  if (missingArticle) {
    return (
      <EditorPage>
        <EditorTopBar
          title="文章不存在"
          description="返回文章列表后可以重新选择。"
          eyebrow="editor.article"
          backHref="/editor/blog"
          width="xl"
        />
        <EditorMain width="xl">
          <StatusMessage tone="danger">未找到要编辑的文章。</StatusMessage>
        </EditorMain>
      </EditorPage>
    );
  }

  return (
    <EditorPage className="pb-8">
      <EditorTopBar
        title={editId ? '编辑文章' : '新建文章'}
        description={frontmatter.title || '未命名草稿'}
        eyebrow="editor.article"
        backHref="/editor/blog"
        width="xl"
        actions={(
          <>
            <LogoutButton />
            <EditorButton onClick={handleExport} aria-label="导出 Markdown">
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">导出</span>
            </EditorButton>

            <EditorButton
              onClick={handleSave}
              disabled={saveState === 'saving'}
              variant={saveState === 'error' ? 'danger' : !hasPersistedArticle || isDirty ? 'primary' : saveState === 'saved' ? 'accent' : 'secondary'}
              className={saveState === 'saved' ? 'border-success-light bg-success-50 text-success' : undefined}
            >
              {saveState === 'saving' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saveState === 'saved' ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : saveState === 'error' ? (
                <AlertCircle className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>{saveState === 'saving' ? '保存中' : saveState === 'saved' ? '已保存' : '保存'}</span>
            </EditorButton>
          </>
        )}
      />

      <EditorMain width="xl" className="space-y-4">
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

        {statusMessage ? (
          <StatusMessage tone={statusMessage.tone}>
            <span>{statusMessage.text}</span>
            {statusMessage.blockingCheck ? (
              <button
                type="button"
                onClick={() => handleResolveQualityCheck(statusMessage.blockingCheck as ArticleQualityCheck)}
                className="mt-3 inline-flex min-h-11 items-center rounded-token-card border border-danger-light bg-surface px-3 text-sm font-medium text-error-600 transition hover:bg-error-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-9"
              >
                定位问题
              </button>
            ) : null}
          </StatusMessage>
        ) : null}

        <MobilePublishingShortcut
          blockingCount={failedBlockingCount}
          descriptionLength={frontmatter.description.trim().length}
          isDirty={isDirty}
          isPersisted={hasPersistedArticle}
          onOpenDetails={() => focusElementById('article-frontmatter-panel')}
          statusLabel={getArticleStatusLabel(frontmatter.status)}
          tagCount={frontmatter.tags.length}
          warningCount={failedWarningCount}
        />

        <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="order-2 space-y-4 xl:order-1">
            <div id="article-frontmatter-panel" tabIndex={-1} className="focus-visible:outline-none">
              <FrontmatterForm
                value={frontmatter}
                onChange={setFrontmatter}
                qualityChecks={frontmatterQualityChecks}
              />
            </div>
            <WritingInspector
              draftSavedAt={draftSavedAt}
              headings={headings}
              isPersisted={hasPersistedArticle}
              isDirty={isDirty}
              onJumpToHeading={handleJumpToHeading}
              onResolveCheck={handleResolveQualityCheck}
              qualityChecks={qualityChecks}
              readingMinutes={readingMinutes}
              templateName={activeTemplate?.name}
              wordCount={wordCount}
            />
          </aside>

          <section className="order-1 overflow-hidden rounded-token-card border border-border bg-surface shadow-token-card xl:order-2">
            <div className="flex flex-col gap-3 border-b border-border bg-background/80 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="font-mono text-xs text-accent">
                  {getArticleKindLabel(frontmatter.kind)} / {getArticleStatusLabel(frontmatter.status)}
                </p>
                <h2 className="truncate text-base font-semibold text-fg">
                  {frontmatter.title || '未命名草稿'}
                </h2>
              </div>
              <ModeSwitch value={editorMode} onChange={setEditorMode} />
            </div>

            <div
              data-editor-workspace
              className={cn(
                'grid h-[min(620px,calc(100svh-260px))] min-h-[420px] md:h-[min(720px,calc(100vh-240px))] md:min-h-[560px] lg:h-[calc(100vh-250px)] lg:min-h-[620px]',
                editorMode === 'split' ? 'grid-rows-2 lg:grid-cols-2 lg:grid-rows-1' : 'grid-cols-1'
              )}
            >
              {editorMode !== 'preview' ? (
                <div className={cn('min-h-0', editorMode === 'split' ? 'border-b border-border lg:border-b-0 lg:border-r' : '')}>
                  <MarkdownEditor
                    textareaId={TEXTAREA_ID}
                    value={content}
                    onChange={setContent}
                    onSave={handleSave}
                    onUploadPastedImage={handleUploadPastedImage}
                    placeholder="开始编写 Markdown..."
                  />
                </div>
              ) : null}

              {editorMode !== 'write' ? (
                <div className="min-h-0">
                  <PreviewPane
                    content={deferredContent}
                    frontmatter={frontmatter}
                    readingMinutes={readingMinutes}
                  />
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </EditorMain>
    </EditorPage>
  );
}
