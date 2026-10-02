'use client';

import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Bold,
  Code2,
  Heading2,
  Image,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  SquareCode,
  Strikethrough,
  Table2,
} from 'lucide-react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  textareaId?: string;
  onSave?: () => void;
  onUploadPastedImage?: (file: File) => Promise<string>;
}

interface CursorMetrics {
  line: number;
  column: number;
}

const LINE_PREFIX_PATTERNS = {
  heading: /^(#{1,6}\s+)/,
  list: /^((?:[-*+]\s+)|(?:\d+\.\s+)|(?:- \[[ xX]\]\s+))/,
  quote: /^(>\s?)/,
};

function getClipboardImageFiles(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function createUploadPlaceholder(index: number): string {
  return `![图片上传中 ${index}](uploading://clipboard-image-${crypto.randomUUID()})`;
}

function createUploadFailureText(message: string): string {
  return `[图片上传失败：${message.replace(/[\r\n[\]]+/g, ' ').trim() || '请稍后重试'}]`;
}

function getCursorMetrics(value: string, cursorIndex: number): CursorMetrics {
  const beforeCursor = value.slice(0, cursorIndex);
  const lines = beforeCursor.split('\n');

  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function getWordCount(value: string): number {
  const cjkCount = value.match(/[\u4e00-\u9fff]/g)?.length || 0;
  const wordCount = value
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return cjkCount + wordCount;
}

function normalizeLinePrefix(line: string, prefix: string, pattern: RegExp): string {
  const indent = line.match(/^\s*/)?.[0] || '';
  const body = line.slice(indent.length).replace(pattern, '');

  return `${indent}${prefix}${body}`;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  textareaId,
  onSave,
  onUploadPastedImage,
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestValueRef = useRef(value);
  const [cursorIndex, setCursorIndex] = useState(0);
  const cursorMetrics = useMemo(() => getCursorMetrics(value, cursorIndex), [cursorIndex, value]);
  const wordCount = useMemo(() => getWordCount(value), [value]);

  latestValueRef.current = value;

  const restoreSelection = useCallback((start: number, end = start) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(start, end);
      setCursorIndex(end);
    });
  }, []);

  const replaceSelection = useCallback((nextValue: string, start: number, end = start) => {
    onChange(nextValue);
    restoreSelection(start, end);
  }, [onChange, restoreSelection]);

  const insertText = useCallback((before: string, after = '', fallback = '') => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = value.slice(start, end);
    const body = selectedText || fallback;
    const nextValue = value.slice(0, start) + before + body + after + value.slice(end);
    const selectionStart = start + before.length;
    const selectionEnd = selectionStart + body.length;

    replaceSelection(nextValue, selectedText ? selectionEnd : selectionStart, selectionEnd);
  }, [replaceSelection, value]);

  const insertBlock = useCallback((block: string, selectNeedle?: string) => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const needsLeadingBreak = start > 0 && value[start - 1] !== '\n';
    const needsTrailingBreak = end < value.length && value[end] !== '\n';
    const prefix = needsLeadingBreak ? '\n\n' : '';
    const suffix = needsTrailingBreak ? '\n\n' : '\n';
    const insertion = `${prefix}${block}${suffix}`;
    const nextValue = value.slice(0, start) + insertion + value.slice(end);
    const needleIndex = selectNeedle ? insertion.indexOf(selectNeedle) : -1;

    if (needleIndex >= 0 && selectNeedle) {
      const selectionStart = start + needleIndex;
      replaceSelection(nextValue, selectionStart, selectionStart + selectNeedle.length);
      return;
    }

    replaceSelection(nextValue, start + insertion.length);
  }, [replaceSelection, value]);

  const transformSelectedLines = useCallback((transformLine: (line: string, lineIndex: number) => string) => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const nextBreak = value.indexOf('\n', end);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    const selectedBlock = value.slice(lineStart, lineEnd);
    const nextBlock = selectedBlock
      .split('\n')
      .map(transformLine)
      .join('\n');
    const nextValue = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);

    replaceSelection(nextValue, lineStart, lineStart + nextBlock.length);
  }, [replaceSelection, value]);

  const toolbarActions = {
    heading: () => transformSelectedLines((line) => normalizeLinePrefix(line, '## ', LINE_PREFIX_PATTERNS.heading)),
    bold: () => insertText('**', '**', '重点内容'),
    italic: () => insertText('*', '*', '强调内容'),
    strikethrough: () => insertText('~~', '~~', '删除内容'),
    code: () => insertText('`', '`', 'code'),
    codeBlock: () => insertBlock('```typescript\nconst value = true;\n```', 'const value = true;'),
    link: () => insertText('[', '](https://example.com)', '链接文字'),
    image: () => insertText('![', '](https://example.com/image.png)', '图片描述'),
    list: () => transformSelectedLines((line) => normalizeLinePrefix(line, '- ', LINE_PREFIX_PATTERNS.list)),
    orderedList: () => transformSelectedLines((line, index) => normalizeLinePrefix(line, `${index + 1}. `, LINE_PREFIX_PATTERNS.list)),
    quote: () => transformSelectedLines((line) => normalizeLinePrefix(line, '> ', LINE_PREFIX_PATTERNS.quote)),
    task: () => transformSelectedLines((line) => normalizeLinePrefix(line, '- [ ] ', LINE_PREFIX_PATTERNS.list)),
    table: () => insertBlock('| 项目 | 说明 |\n| --- | --- |\n|  |  |'),
    callout: () => insertBlock('> [!NOTE]\n> 这里写提示内容。', '这里写提示内容。'),
    hr: () => insertBlock('---'),
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isShortcut = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (isShortcut && key === 's') {
      event.preventDefault();
      onSave?.();
      return;
    }

    if (isShortcut && key === 'b') {
      event.preventDefault();
      toolbarActions.bold();
      return;
    }

    if (isShortcut && key === 'i') {
      event.preventDefault();
      toolbarActions.italic();
      return;
    }

    if (isShortcut && event.shiftKey && key === 'x') {
      event.preventDefault();
      toolbarActions.strikethrough();
      return;
    }

    if (isShortcut && key === 'e') {
      event.preventDefault();
      toolbarActions.code();
      return;
    }

    if (isShortcut && key === 'k') {
      event.preventDefault();
      toolbarActions.link();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      insertText('  ');
    }
  };

  const handleCursorChange = () => {
    setCursorIndex(textareaRef.current?.selectionStart || 0);
  };

  const replaceUploadPlaceholder = useCallback((placeholder: string, replacement: string) => {
    const latestValue = latestValueRef.current;

    if (!latestValue.includes(placeholder)) {
      return;
    }

    const nextValue = latestValue.replace(placeholder, replacement);
    latestValueRef.current = nextValue;
    onChange(nextValue);
  }, [onChange]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onUploadPastedImage) {
      return;
    }

    const files = getClipboardImageFiles(event);
    const textarea = textareaRef.current;

    if (!files.length || !textarea) {
      return;
    }

    event.preventDefault();

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const placeholders = files.map((_, index) => createUploadPlaceholder(index + 1));
    const insertion = placeholders.join('\n\n');
    const nextValue = value.slice(0, start) + insertion + value.slice(end);
    const nextCursor = start + insertion.length;

    latestValueRef.current = nextValue;
    replaceSelection(nextValue, nextCursor);

    placeholders.forEach((uploadPlaceholder, index) => {
      void onUploadPastedImage(files[index])
        .then((markdown) => replaceUploadPlaceholder(uploadPlaceholder, markdown))
        .catch((error: unknown) => {
          const message = error instanceof Error && error.message ? error.message : '请稍后重试';
          replaceUploadPlaceholder(uploadPlaceholder, createUploadFailureText(message));
        });
    });
  }, [onUploadPastedImage, replaceSelection, replaceUploadPlaceholder, value]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b border-border bg-background/80">
        <div
          data-editor-toolbar
          role="toolbar"
          aria-label="Markdown 格式工具"
          className="flex min-h-12 items-center gap-2 overflow-x-auto p-2 pr-9 [scrollbar-width:thin] sm:gap-1 sm:pr-2"
        >
          <ToolbarButton onClick={toolbarActions.heading} title="标题">
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={toolbarActions.bold} title="加粗" shortcut="Control+B Meta+B">
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.italic} title="斜体" shortcut="Control+I Meta+I">
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.strikethrough} title="删除线" shortcut="Control+Shift+X Meta+Shift+X">
            <Strikethrough className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={toolbarActions.code} title="行内代码" shortcut="Control+E Meta+E">
            <Code2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.codeBlock} title="代码块">
            <SquareCode className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.callout} title="提示块">
            <Pilcrow className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={toolbarActions.link} title="链接" shortcut="Control+K Meta+K">
            <Link2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.image} title="图片">
            <Image className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={toolbarActions.list} title="无序列表">
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.orderedList} title="有序列表">
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.task} title="任务列表">
            <ListChecks className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.table} title="表格">
            <Table2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={toolbarActions.quote} title="引用">
            <Quote className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton onClick={toolbarActions.hr} title="分隔线">
            <Minus className="h-4 w-4" />
          </ToolbarButton>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-9 bg-gradient-to-l from-background via-background/85 to-transparent sm:hidden"
        />
      </div>

      <textarea
        id={textareaId}
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={handleCursorChange}
        onKeyUp={handleCursorChange}
        onSelect={handleCursorChange}
        placeholder={placeholder || '开始编写 Markdown...'}
        className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-sm leading-relaxed text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-link focus-visible:ring-inset"
        spellCheck={false}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-background/80 px-3 py-2 font-mono text-xs text-subtle">
        <span>
          Ln {cursorMetrics.line}, Col {cursorMetrics.column}
        </span>
        <span>{wordCount} 字</span>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  shortcut,
  children,
}: {
  onClick: () => void;
  title: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-keyshortcuts={shortcut}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-token-card text-muted transition-colors hover:bg-accent-50 hover:text-accent focus:ring-2 focus:ring-link focus:ring-offset-2 sm:h-8 sm:w-8"
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
