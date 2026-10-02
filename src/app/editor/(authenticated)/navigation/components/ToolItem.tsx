'use client';

import { useEffect, useState } from 'react';
import { Check, Edit2, Link2, Trash2, X } from 'lucide-react';
import type { Tool } from '@/app/types/navigation';
import { cn } from '@/lib/utils';
import { useTagsText } from '@/app/hooks/useTagsText';
import { EditorButton, editorInputClassName } from '../../../components/EditorShell';
import {
  editorFieldLabelClassName,
  focusToolField,
  getToolFieldError,
  toolInputProps,
  toolTextInputProps,
  validateTool,
  type ToolValidationError,
} from './tool-form';
import { ToolFieldError } from './ToolFieldError';

export interface ToolItemProps {
  categoryIndex: number;
  toolIndex: number;
  tool: Tool;
  onEdit: () => void;
  onDelete: () => void;
  isEditing: boolean;
  isDeleting: boolean;
  onSave: (updates: Partial<Tool>) => void;
  onCancel: () => void;
}

export function ToolItem({
  categoryIndex,
  toolIndex,
  tool,
  onEdit,
  onDelete,
  isEditing,
  isDeleting,
  onSave,
  onCancel,
}: ToolItemProps) {
  const [form, setForm] = useState(tool);
  const [validationError, setValidationError] = useState<ToolValidationError | null>(null);
  const [tagsText, handleTagsTextChange] = useTagsText(form.tags, (tags) => updateForm({ tags }));
  const fieldPrefix = `edit-tool-${categoryIndex}-${toolIndex}`;

  // Re-entering edit mode must show the tool as it is right now, not the state
  // captured when the item first mounted.
  useEffect(() => {
    if (isEditing) {
      setForm(tool);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only on the edit-mode transition
  }, [isEditing]);

  const updateForm = (updates: Partial<Tool>) => {
    setForm((current) => ({ ...current, ...updates }));
    setValidationError(null);
  };

  const handleSave = () => {
    const normalizedTool = {
      ...form,
      icon: form.icon.trim() || 'link',
      title: form.title.trim(),
      description: form.description.trim(),
      url: form.url.trim(),
      tags: form.tags.filter(Boolean),
    };
    const nextValidationError = validateTool(normalizedTool);

    if (nextValidationError) {
      setValidationError(nextValidationError);
      focusToolField(fieldPrefix, nextValidationError.field);
      return;
    }

    setValidationError(null);
    onSave(normalizedTool);
  };

  if (isEditing) {
    const titleError = getToolFieldError(validationError, 'title');
    const titleProps = toolInputProps(fieldPrefix, 'title', titleError);
    const urlError = getToolFieldError(validationError, 'url');
    const urlProps = toolInputProps(fieldPrefix, 'url', urlError);
    const descriptionError = getToolFieldError(validationError, 'description');
    const descriptionProps = toolInputProps(fieldPrefix, 'description', descriptionError);
    const tagsError = getToolFieldError(validationError, 'tags');
    const tagsProps = toolInputProps(fieldPrefix, 'tags', tagsError);

    return (
      <section
        className="bg-accent-50/60 p-3"
        aria-labelledby={`${fieldPrefix}-heading`}
      >
        <div className="mb-3 flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-token-card border border-danger-light bg-surface text-accent">
            <Edit2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 id={`${fieldPrefix}-heading`} className="text-sm font-semibold text-fg">
              编辑工具：{tool.title}
            </h3>
            <p className="mt-1 text-xs text-muted">
              修改会直接更新当前分类里的链接条目。
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label>
            <span className={editorFieldLabelClassName()}>工具名称</span>
            <input
              value={form.title}
              onChange={(e) => updateForm({ title: e.target.value })}
              className={editorInputClassName}
              {...toolTextInputProps('title')}
              {...titleProps}
            />
            <ToolFieldError id={titleProps.id} message={titleError} />
          </label>
          <label>
            <span className={editorFieldLabelClassName()}>URL</span>
            <input
              value={form.url}
              onChange={(e) => updateForm({ url: e.target.value })}
              className={editorInputClassName}
              {...toolTextInputProps('url')}
              {...urlProps}
            />
            <ToolFieldError id={urlProps.id} message={urlError} />
          </label>
          <label>
            <span className={editorFieldLabelClassName()}>描述</span>
            <input
              value={form.description}
              onChange={(e) => updateForm({ description: e.target.value })}
              className={editorInputClassName}
              {...toolTextInputProps('description')}
              {...descriptionProps}
            />
            <ToolFieldError id={descriptionProps.id} message={descriptionError} />
          </label>
          <label>
            <span className={editorFieldLabelClassName()}>标签</span>
            <input
              value={tagsText}
              onChange={(e) => handleTagsTextChange(e.target.value)}
              className={editorInputClassName}
              {...toolTextInputProps('tags')}
              {...tagsProps}
            />
            <ToolFieldError id={tagsProps.id} message={tagsError} />
          </label>
        </div>
        {validationError ? (
          <p className="mt-3 text-sm text-error-600">{validationError.message}</p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <EditorButton
            onClick={handleSave}
            className="px-3 py-1.5"
            variant="primary"
          >
            <Check className="w-3 h-3" />
            保存
          </EditorButton>
          <EditorButton
            onClick={onCancel}
            className="px-3 py-1.5"
            variant="ghost"
          >
            <X className="w-3 h-3" />
            取消
          </EditorButton>
        </div>
      </section>
    );
  }

  return (
    <div className="group grid gap-3 px-4 py-2.5 transition-colors hover:bg-background/70 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <Link2 className="mt-1 h-4 w-4 shrink-0 text-subtle" />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span className="truncate font-medium text-fg">{tool.title}</span>
            {tool.tags.length > 0 && (
              <span className="line-clamp-1 text-xs text-subtle sm:shrink-0">({tool.tags.join(', ')})</span>
            )}
          </div>
          <div className="mt-1 line-clamp-2 text-sm text-muted">{tool.description || tool.url}</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <a
          href={tool.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
          aria-label={`打开工具：${tool.title}`}
        >
          <Link2 className="w-4 h-4" />
        </a>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9"
          aria-label={`编辑工具：${tool.title}`}
        >
          <Edit2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className={cn(
            'inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card transition-colors focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-9',
            isDeleting
              ? 'bg-error-50 text-error-600'
              : 'text-subtle hover:bg-error-50 hover:text-error-600'
          )}
          aria-label={`${isDeleting ? '确认删除工具' : '删除工具'}：${tool.title}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
