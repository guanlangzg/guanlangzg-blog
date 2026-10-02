import type { Tool } from '@/app/types/navigation';
import { isValidNavigationUrl } from '@/lib/navigation-data';

export function editorFieldLabelClassName() {
  return 'mb-1.5 block text-xs font-mono text-muted';
}

export type ToolValidationField = 'title' | 'url' | 'description' | 'tags';

export type ToolValidationError = {
  field: ToolValidationField;
  message: string;
};

export function validateTool(tool: Tool): ToolValidationError | null {
  if (!tool.title.trim()) {
    return { field: 'title', message: '请填写工具名称。' };
  }

  if (!isValidNavigationUrl(tool.url)) {
    return {
      field: 'url',
      message: process.env.NODE_ENV === 'production'
        ? 'URL 必须是完整的 https:// 链接。'
        : 'URL 必须是完整的 https:// 链接，或本地开发用 http://localhost 链接。',
    };
  }

  if (!tool.description.trim()) {
    return { field: 'description', message: '请填写工具描述。' };
  }

  if (tool.tags.filter(Boolean).length === 0) {
    return { field: 'tags', message: '请至少填写一个标签。' };
  }

  return null;
}

export function getToolFieldId(prefix: string, field: ToolValidationField): string {
  return `${prefix}-${field}`;
}

export function getCategoryEditFieldId(categoryIndex: number): string {
  return `edit-category-${categoryIndex}-name`;
}

export function focusToolField(prefix: string, field: ToolValidationField): void {
  window.requestAnimationFrame(() => {
    document.getElementById(getToolFieldId(prefix, field))?.focus();
  });
}

export function focusCategoryEditField(categoryIndex: number): void {
  window.requestAnimationFrame(() => {
    document.getElementById(getCategoryEditFieldId(categoryIndex))?.focus();
  });
}

export function getToolFieldError(
  error: ToolValidationError | null,
  field: ToolValidationField
): string | undefined {
  return error?.field === field ? error.message : undefined;
}

export function toolInputProps(
  prefix: string,
  field: ToolValidationField,
  error?: string
): {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
} {
  const id = getToolFieldId(prefix, field);

  return {
    id,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? `${id}-error` : undefined,
  };
}

export function toolTextInputProps(field: ToolValidationField): {
  autoCapitalize?: 'none';
  autoCorrect?: 'off';
  inputMode?: 'url';
  spellCheck?: boolean;
  type: 'text' | 'url';
} {
  if (field !== 'url') {
    return { type: 'text' };
  }

  return {
    autoCapitalize: 'none',
    autoCorrect: 'off',
    inputMode: 'url',
    spellCheck: false,
    type: 'url',
  };
}
