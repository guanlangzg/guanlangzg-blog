'use client';

import { useState, useCallback, useMemo } from 'react';
import { Plus, Download, Upload, RotateCcw, Folder, Trash2, Edit2, X, Check } from 'lucide-react';
import { useNavigationData } from '@/app/hooks/useNavigationData';
import { useTagsText } from '@/app/hooks/useTagsText';
import { Category, Tool } from '@/app/types/navigation';
import { EmptyState, StatusMessage } from '@/app/components/ui';
import { ToolItem } from './components/ToolItem';
import { ToolFieldError } from './components/ToolFieldError';
import {
  editorFieldLabelClassName,
  focusCategoryEditField,
  focusToolField,
  getCategoryEditFieldId,
  getToolFieldError,
  toolInputProps,
  toolTextInputProps,
  validateTool,
  type ToolValidationError,
} from './components/tool-form';
import { LogoutButton } from '../../components/LogoutButton';
import { EditorLoading } from '../../components/EditorLoading';
import {
  EditorButton,
  EditorMain,
  EditorPage,
  EditorPanel,
  EditorTopBar,
  editorInputClassName,
} from '../../components/EditorShell';

// Indexes shift when an entry is removed or the whole list is replaced, so
// editing/deleting state must be bound to the entry itself. A category keeps
// its identity while only its tools change, and a tool keeps its identity
// while the page re-renders around it.
function createCategoryIdentity(category: Category): string {
  return [category.name, category.icon, category.slug].join('\u0000');
}

function createToolIdentity(tool: Tool): string {
  return [tool.icon, tool.title, tool.description, tool.url, tool.tags.join('\u0000')].join('\u0000');
}

function createEntryKeys<T>(values: readonly T[], createIdentity: (value: T) => string): string[] {
  const occurrences = new Map<string, number>();

  return values.map((value) => {
    const identity = createIdentity(value);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);

    return `${identity}\u0001${occurrence}`;
  });
}

export default function NavigationEditorPage() {
  const {
    data,
    isLoaded,
    addCategory,
    updateCategory,
    deleteCategory,
    addTool,
    updateTool,
    deleteTool,
    exportData,
    importData,
    resetToDefault,
    lastConflictAt,
    lastRemoteLoadError,
    lastRemoteSaveError,
  } = useNavigationData();

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingTool, setEditingTool] = useState<{ categoryId: string; toolId: string } | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [addingToolCategoryId, setAddingToolCategoryId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [categoryFormError, setCategoryFormError] = useState('');
  const [categoryEditName, setCategoryEditName] = useState('');
  const [categoryEditError, setCategoryEditError] = useState('');
  const [toolFormError, setToolFormError] = useState<ToolValidationError | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const [categoryForm, setCategoryForm] = useState({ name: '', icon: 'folder', slug: '' });
  const [toolForm, setToolForm] = useState<Tool>({
    icon: 'link',
    title: '',
    description: '',
    url: '',
    tags: [],
  });
  const [toolTagsText, handleToolTagsTextChange] = useTagsText(
    toolForm.tags,
    (tags) => setToolForm((current) => ({ ...current, tags }))
  );

  const categoryIds = useMemo(() => createEntryKeys(data, createCategoryIdentity), [data]);
  const toolIdsByCategory = useMemo(
    () => data.map((category) => createEntryKeys(category.tools, createToolIdentity)),
    [data]
  );
  const categoryIndexById = useMemo(() => {
    const indexes = new Map<string, number>();

    categoryIds.forEach((id, index) => indexes.set(id, index));

    return indexes;
  }, [categoryIds]);
  const findToolLocation = useCallback(
    (categoryId: string, toolId: string): { categoryIndex: number; toolIndex: number } | null => {
      const categoryIndex = categoryIndexById.get(categoryId);

      if (categoryIndex === undefined) {
        return null;
      }

      const toolIndex = toolIdsByCategory[categoryIndex]?.indexOf(toolId) ?? -1;

      return toolIndex < 0 ? null : { categoryIndex, toolIndex };
    },
    [categoryIndexById, toolIdsByCategory]
  );

  const handleAddCategory = useCallback(() => {
    if (!categoryForm.name.trim()) {
      setCategoryFormError('请填写分类名称。');
      window.requestAnimationFrame(() => {
        document.getElementById('new-category-name')?.focus();
      });
      return;
    }

    addCategory({
      name: categoryForm.name.trim(),
      icon: categoryForm.icon.trim() || 'folder',
      slug: categoryForm.slug || categoryForm.name.toLowerCase().replace(/\s+/g, '-'),
    });
    setCategoryForm({ name: '', icon: 'folder', slug: '' });
    setCategoryFormError('');
    setMessage({ tone: 'success', text: '分类已添加。' });
    setShowAddCategory(false);
  }, [categoryForm, addCategory]);

  const startEditingCategory = useCallback((categoryId: string, categoryName: string) => {
    setEditingCategoryId(categoryId);
    setCategoryEditName(categoryName);
    setCategoryEditError('');
  }, []);

  const cancelEditingCategory = useCallback(() => {
    setEditingCategoryId(null);
    setCategoryEditName('');
    setCategoryEditError('');
  }, []);

  const handleSaveCategory = useCallback(() => {
    const categoryIndex = editingCategoryId ? categoryIndexById.get(editingCategoryId) : undefined;

    if (categoryIndex === undefined) {
      cancelEditingCategory();
      return;
    }

    const nextName = categoryEditName.trim();

    if (!nextName) {
      setCategoryEditError('请填写分类名称。');
      focusCategoryEditField(categoryIndex);
      return;
    }

    updateCategory(categoryIndex, { name: nextName });
    setMessage({ tone: 'success', text: '分类名称已更新。' });
    cancelEditingCategory();
  }, [cancelEditingCategory, categoryEditName, categoryIndexById, editingCategoryId, updateCategory]);

  const handleAddTool = useCallback(
    (categoryId: string) => {
      const categoryIndex = categoryIndexById.get(categoryId);

      if (categoryIndex === undefined) {
        setAddingToolCategoryId(null);
        return;
      }

      const normalizedTool = {
        ...toolForm,
        icon: toolForm.icon.trim() || 'link',
        title: toolForm.title.trim(),
        description: toolForm.description.trim(),
        url: toolForm.url.trim(),
        tags: toolForm.tags.filter(Boolean),
      };
      const validationError = validateTool(normalizedTool);

      if (validationError) {
        setToolFormError(validationError);
        focusToolField(`new-tool-${categoryIndex}`, validationError.field);
        return;
      }

      addTool(categoryIndex, {
        ...normalizedTool,
      });
      setToolForm({
        icon: 'link',
        title: '',
        description: '',
        url: '',
        tags: [],
      });
      setToolFormError(null);
      setMessage({ tone: 'success', text: '工具链接已添加。' });
      setAddingToolCategoryId(null);
    },
    [addTool, categoryIndexById, toolForm]
  );

  const handleExport = useCallback(() => {
    const json = exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'navigation-data.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMessage({ tone: 'success', text: '导航数据已导出。' });
  }, [exportData]);

  const handleReset = useCallback(() => {
    resetToDefault();
    setMessage({ tone: 'info', text: '导航数据已重置为种子数据。' });
  }, [resetToDefault]);

  const handleDeleteCategory = useCallback((categoryId: string) => {
    const confirmKey = `category:${categoryId}`;

    if (deleteConfirm !== confirmKey) {
      setDeleteConfirm(confirmKey);
      setMessage({ tone: 'info', text: '再次点击删除按钮确认删除分类。' });
      window.setTimeout(() => {
        setDeleteConfirm((current) => (current === confirmKey ? null : current));
      }, 3000);
      return;
    }

    const categoryIndex = categoryIndexById.get(categoryId);
    const deleted = categoryIndex === undefined ? false : deleteCategory(categoryIndex);
    setDeleteConfirm(null);
    setMessage(deleted
      ? { tone: 'success', text: '分类已删除。' }
      : { tone: 'danger', text: '分类删除失败。' });
  }, [categoryIndexById, deleteCategory, deleteConfirm]);

  const handleDeleteTool = useCallback((categoryId: string, toolId: string) => {
    const confirmKey = `tool:${categoryId}:${toolId}`;

    if (deleteConfirm !== confirmKey) {
      setDeleteConfirm(confirmKey);
      setMessage({ tone: 'info', text: '再次点击删除按钮确认删除工具链接。' });
      window.setTimeout(() => {
        setDeleteConfirm((current) => (current === confirmKey ? null : current));
      }, 3000);
      return;
    }

    const location = findToolLocation(categoryId, toolId);
    const deleted = location
      ? deleteTool(location.categoryIndex, location.toolIndex)
      : false;
    setDeleteConfirm(null);
    setMessage(deleted
      ? { tone: 'success', text: '工具链接已删除。' }
      : { tone: 'danger', text: '工具链接删除失败。' });
  }, [deleteConfirm, deleteTool, findToolLocation]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      const handleReadError = () => {
        setMessage({ tone: 'danger', text: '导航数据文件读取失败，请重新选择 JSON 文件。' });
      };

      reader.onload = (event) => {
        const content = typeof event.target?.result === 'string' ? event.target.result : '';

        if (!content.trim()) {
          setMessage({ tone: 'danger', text: '导航数据导入失败，请检查 JSON 格式。' });
          return;
        }

        const imported = importData(content);
        setMessage(imported
          ? { tone: 'success', text: '导航数据已导入。' }
          : { tone: 'danger', text: '导航数据导入失败，请检查 JSON 格式。' });
      };
      reader.onerror = handleReadError;
      reader.onabort = handleReadError;
      reader.readAsText(file);
      e.target.value = '';
    },
    [importData]
  );

  if (!isLoaded) {
    return <EditorLoading />;
  }

  return (
    <EditorPage className="pb-12">
      <EditorTopBar
        title="导航编辑器"
        description={`${data.length} 个分类，${data.reduce((acc, cat) => acc + cat.tools.length, 0)} 个工具`}
        eyebrow="editor.navigation"
        backHref="/editor"
        actions={(
          <>
            <LogoutButton />
            <label
              className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-token-card border border-border bg-surface px-3 py-2 text-sm font-medium text-fg transition hover:border-border hover:bg-surface focus-within:ring-2 focus-within:ring-link focus-within:ring-offset-2 sm:min-h-10 sm:min-w-0"
              aria-label="导入导航数据"
            >
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">导入</span>
              <input
                type="file"
                accept=".json"
                onChange={handleImport}
                className="sr-only"
                aria-label="导入导航数据"
              />
            </label>

            <EditorButton
              onClick={handleExport}
              aria-label="导出导航数据"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">导出</span>
            </EditorButton>

            <EditorButton
              onClick={handleReset}
              aria-label="重置导航数据"
            >
              <RotateCcw className="h-4 w-4" />
              <span className="hidden sm:inline">重置</span>
            </EditorButton>

            <EditorButton
              onClick={() => setShowAddCategory(true)}
              variant="primary"
            >
              <Plus className="h-4 w-4" />
              添加分类
            </EditorButton>
          </>
        )}
      />

      <EditorMain className="space-y-4">
        {lastConflictAt ? (
          <StatusMessage tone="warning">
            服务器上的导航数据更新较新，已载入服务器版本；请确认当前内容后继续编辑。
          </StatusMessage>
        ) : null}

        {lastRemoteLoadError ? (
          <StatusMessage tone="warning">
            导航从服务器加载失败，当前显示本机副本：{lastRemoteLoadError.message}
          </StatusMessage>
        ) : null}

        {lastRemoteSaveError ? (
          <StatusMessage tone="warning">
            导航已保存在本机，但同步到服务器失败：{lastRemoteSaveError.message}
          </StatusMessage>
        ) : null}

        {message ? (
          <StatusMessage tone={message.tone}>
            {message.text}
          </StatusMessage>
        ) : null}

        {showAddCategory && (
          <EditorPanel className="p-4">
            <h3 className="mb-3 text-base font-medium text-fg">添加分类</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label>
                <span className={editorFieldLabelClassName()}>分类名称</span>
                <input
                  id="new-category-name"
                  type="text"
                  placeholder="常用入口"
                  value={categoryForm.name}
                  onChange={(e) => {
                    setCategoryForm({ ...categoryForm, name: e.target.value });
                    setCategoryFormError('');
                  }}
                  className={editorInputClassName}
                  aria-invalid={Boolean(categoryFormError)}
                  aria-describedby={categoryFormError ? 'new-category-name-error' : undefined}
                />
                {categoryFormError ? (
                  <p id="new-category-name-error" className="mt-1 text-xs text-error-600" role="alert">
                    {categoryFormError}
                  </p>
                ) : null}
              </label>
              <label>
                <span className={editorFieldLabelClassName()}>图标</span>
                <input
                  type="text"
                  placeholder="folder"
                  value={categoryForm.icon}
                  onChange={(e) => setCategoryForm({ ...categoryForm, icon: e.target.value })}
                  className={editorInputClassName}
                />
              </label>
              <label>
                <span className={editorFieldLabelClassName()}>Slug</span>
                <input
                  type="text"
                  placeholder="quick-access"
                  value={categoryForm.slug}
                  onChange={(e) => setCategoryForm({ ...categoryForm, slug: e.target.value })}
                  className={editorInputClassName}
                />
              </label>
            </div>
            {categoryFormError ? (
              <p className="mt-3 text-sm text-error-600">{categoryFormError}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <EditorButton
                onClick={handleAddCategory}
                variant="primary"
              >
                确认添加
              </EditorButton>
              <EditorButton
                onClick={() => setShowAddCategory(false)}
                variant="ghost"
              >
                取消
              </EditorButton>
            </div>
          </EditorPanel>
        )}

        {data.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="还没有导航分类"
            description="添加一个分类后，就可以开始整理常用工具链接。"
            action={(
              <EditorButton
                onClick={() => setShowAddCategory(true)}
                variant="accent"
              >
                <Plus className="h-4 w-4" />
                添加分类
              </EditorButton>
            )}
          />
        ) : (
          <div className="space-y-4">
            {data.map((category, categoryIndex) => {
              const categoryId = categoryIds[categoryIndex];
              const toolIds = toolIdsByCategory[categoryIndex];

              return (
              <EditorPanel key={categoryId} className="overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-border bg-background/70 px-4 py-3 md:flex-row md:items-center md:justify-between">
                  {editingCategoryId === categoryId ? (
                    <label className="flex-1">
                      <span className={editorFieldLabelClassName()}>分类名称</span>
                      <input
                        id={getCategoryEditFieldId(categoryIndex)}
                        type="text"
                        value={categoryEditName}
                        onChange={(e) => {
                          setCategoryEditName(e.target.value);
                          setCategoryEditError('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSaveCategory();
                          }

                          if (e.key === 'Escape') {
                            cancelEditingCategory();
                          }
                        }}
                        className={editorInputClassName}
                        aria-invalid={Boolean(categoryEditError)}
                        aria-describedby={categoryEditError ? `${getCategoryEditFieldId(categoryIndex)}-error` : undefined}
                        autoFocus
                      />
                      {categoryEditError ? (
                        <p id={`${getCategoryEditFieldId(categoryIndex)}-error`} className="mt-1 text-xs text-error-600" role="alert">
                          {categoryEditError}
                        </p>
                      ) : null}
                    </label>
                  ) : (
                    <div className="flex min-w-0 items-center gap-3">
                      <Folder className="h-5 w-5 shrink-0 text-accent" />
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-medium text-fg">{category.name}</h2>
                        <p className="mt-0.5 font-mono text-xs text-subtle">{category.tools.length} tools</p>
                      </div>
                    </div>
                  )}

                  <div className="flex w-full items-center justify-between gap-2 md:w-auto md:justify-end">
                    {editingCategoryId === categoryId ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveCategory}
                          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card bg-accent text-accent-fg transition-colors hover:bg-accent-600 focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
                          aria-label={`保存分类：${category.name}`}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditingCategory}
                          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-surface hover:text-fg focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
                          aria-label={`取消编辑分类：${category.name}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => startEditingCategory(categoryId, category.name)}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
                            aria-label={`编辑分类：${category.name}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCategory(categoryId)}
                            className={deleteConfirm === `category:${categoryId}`
                              ? 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card bg-error-50 text-error-600 transition-colors focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9'
                              : 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-error-50 hover:text-error-600 focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9'}
                            aria-label={`${deleteConfirm === `category:${categoryId}` ? '确认删除分类' : '删除分类'}：${category.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <EditorButton
                          onClick={() => setAddingToolCategoryId(categoryId)}
                          className="whitespace-nowrap px-3 py-1.5"
                          variant="accent"
                        >
                          <Plus className="h-3 w-3" />
                          添加工具
                        </EditorButton>
                      </>
                    )}
                  </div>
                </div>

                {addingToolCategoryId === categoryId && (
                  <section
                    className="border-b border-border bg-accent-50/60 p-3"
                    aria-labelledby={`new-tool-${categoryIndex}-heading`}
                  >
                    <div className="mb-3 flex items-start gap-2">
                      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-token-card border border-danger-light bg-surface text-accent">
                        <Plus className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <h3 id={`new-tool-${categoryIndex}-heading`} className="text-sm font-semibold text-fg">
                          添加工具到 {category.name}
                        </h3>
                        <p className="mt-1 text-xs text-muted">
                          先补齐名称、URL、描述和标签，再保存到当前分类。
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <label>
                        <span className={editorFieldLabelClassName()}>工具名称</span>
                        {(() => {
                          const error = getToolFieldError(toolFormError, 'title');
                          const fieldProps = toolInputProps(`new-tool-${categoryIndex}`, 'title', error);

                          return (
                            <>
                              <input
                                placeholder="MDN Web Docs"
                                value={toolForm.title}
                                onChange={(e) => setToolForm({ ...toolForm, title: e.target.value })}
                                className={editorInputClassName}
                                {...toolTextInputProps('title')}
                                {...fieldProps}
                              />
                              <ToolFieldError id={fieldProps.id} message={error} />
                            </>
                          );
                        })()}
                      </label>
                      <label>
                        <span className={editorFieldLabelClassName()}>URL</span>
                        {(() => {
                          const error = getToolFieldError(toolFormError, 'url');
                          const fieldProps = toolInputProps(`new-tool-${categoryIndex}`, 'url', error);

                          return (
                            <>
                              <input
                                placeholder="https://developer.mozilla.org"
                                value={toolForm.url}
                                onChange={(e) => setToolForm({ ...toolForm, url: e.target.value })}
                                className={editorInputClassName}
                                {...toolTextInputProps('url')}
                                {...fieldProps}
                              />
                              <ToolFieldError id={fieldProps.id} message={error} />
                            </>
                          );
                        })()}
                      </label>
                      <label>
                        <span className={editorFieldLabelClassName()}>描述</span>
                        {(() => {
                          const error = getToolFieldError(toolFormError, 'description');
                          const fieldProps = toolInputProps(`new-tool-${categoryIndex}`, 'description', error);

                          return (
                            <>
                              <input
                                placeholder="说明这个入口解决什么问题"
                                value={toolForm.description}
                                onChange={(e) => setToolForm({ ...toolForm, description: e.target.value })}
                                className={editorInputClassName}
                                {...toolTextInputProps('description')}
                                {...fieldProps}
                              />
                              <ToolFieldError id={fieldProps.id} message={error} />
                            </>
                          );
                        })()}
                      </label>
                      <label>
                        <span className={editorFieldLabelClassName()}>标签</span>
                        {(() => {
                          const error = getToolFieldError(toolFormError, 'tags');
                          const fieldProps = toolInputProps(`new-tool-${categoryIndex}`, 'tags', error);

                          return (
                            <>
                              <input
                                placeholder="文档, Web, 参考"
                                value={toolTagsText}
                                onChange={(e) => handleToolTagsTextChange(e.target.value)}
                                className={editorInputClassName}
                                {...toolTextInputProps('tags')}
                                {...fieldProps}
                              />
                              <ToolFieldError id={fieldProps.id} message={error} />
                            </>
                          );
                        })()}
                      </label>
                    </div>
                    {toolFormError ? (
                      <p className="mt-3 text-sm text-error-600">{toolFormError.message}</p>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <EditorButton
                        onClick={() => handleAddTool(categoryId)}
                        variant="primary"
                      >
                        确认添加
                      </EditorButton>
                      <EditorButton
                        onClick={() => setAddingToolCategoryId(null)}
                        variant="ghost"
                      >
                        取消
                      </EditorButton>
                    </div>
                  </section>
                )}

                <div className="divide-y divide-border-soft">
                  {category.tools.map((tool, toolIndex) => {
                    const toolId = toolIds[toolIndex];

                    return (
                    <ToolItem
                      key={toolId}
                      categoryIndex={categoryIndex}
                      toolIndex={toolIndex}
                      tool={tool}
                      onEdit={() => setEditingTool({ categoryId, toolId })}
                      onDelete={() => handleDeleteTool(categoryId, toolId)}
                      isDeleting={deleteConfirm === `tool:${categoryId}:${toolId}`}
                      isEditing={
                        editingTool?.categoryId === categoryId &&
                        editingTool?.toolId === toolId
                      }
                      onSave={(updates) => {
                        updateTool(categoryIndex, toolIndex, updates);
                        setMessage({ tone: 'success', text: '工具链接已更新。' });
                        setEditingTool(null);
                      }}
                      onCancel={() => setEditingTool(null)}
                    />
                    );
                  })}
                </div>
              </EditorPanel>
              );
            })}
          </div>
        )}
      </EditorMain>
    </EditorPage>
  );
}
