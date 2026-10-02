'use client';

import { useCallback, useState, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    isSearchQueryAllowed,
    normalizeSearchQuery,
} from '@/lib/search-query';
import { ADMIN_SHORTCUT, useCommandSearch } from './useCommandSearch';
import { getSearchResultId, SearchResultItem } from './SearchResultItem';
import { CommandAdminMenu, type EditorAuthStatus } from './CommandAdminMenu';

const COMMAND_SEARCH_PANEL_ID = 'command-search-panel';

interface CommandInputProps {
    compact?: boolean;
    className?: string;
}

const placeholders = [
    '搜索 React 优化...',
    '搜索 Next.js...',
    '搜索 TypeScript...',
    '搜索 MDN...',
    '搜索 GitHub...',
    '输入 :admin...',
];

export function CommandInput({ compact = false, className }: CommandInputProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [placeholder, setPlaceholder] = useState('');
    const [placeholderIndex, setPlaceholderIndex] = useState(0);
    const [charIndex, setCharIndex] = useState(0);
    const [isDeleting, setIsDeleting] = useState(false);
    const [activeResultIndex, setActiveResultIndex] = useState(-1);
    const [editorAuthStatus, setEditorAuthStatus] = useState<EditorAuthStatus | null>(null);
    const [isEditorAuthStatusLoading, setIsEditorAuthStatusLoading] = useState(false);
    const [editorAuthStatusError, setEditorAuthStatusError] = useState<string | null>(null);
    const desktopInputRef = useRef<HTMLInputElement>(null);
    const panelInputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const lastFocusedElementRef = useRef<HTMLElement | null>(null);
    const hasSearchableQuery = isSearchQueryAllowed(normalizeSearchQuery(query));
    const { results, isLoading, errorMessage, isAdminShortcut } = useCommandSearch(query);

    const focusSearchInput = useCallback(() => {
        setTimeout(() => {
            const input = compact ? panelInputRef.current : desktopInputRef.current;
            input?.focus();
        }, 0);
    }, [compact]);

    const closeSearch = useCallback(() => {
        setIsOpen(false);
        setQuery('');
        setActiveResultIndex(-1);
        setEditorAuthStatus(null);
        setEditorAuthStatusError(null);

        setTimeout(() => {
            lastFocusedElementRef.current?.focus();
            lastFocusedElementRef.current = null;
        }, 0);
    }, []);

    const openSearch = useCallback(() => {
        if (!isOpen) {
            lastFocusedElementRef.current = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        }

        setIsOpen(true);
        focusSearchInput();
    }, [focusSearchInput, isOpen]);

    const clearQuery = useCallback(() => {
        setQuery('');
        setEditorAuthStatus(null);
        setEditorAuthStatusError(null);
        focusSearchInput();
    }, [focusSearchInput]);

    const handleSearchInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
            return;
        }

        if (event.key === 'ArrowDown' && results.length > 0) {
            event.preventDefault();
            setActiveResultIndex((index) => (index + 1) % results.length);
            return;
        }

        if (event.key === 'ArrowUp' && results.length > 0) {
            event.preventDefault();
            setActiveResultIndex((index) => index <= 0 ? results.length - 1 : index - 1);
            return;
        }

        if (event.key === 'Enter' && activeResultIndex >= 0) {
            event.preventDefault();
            const activeResult = panelRef.current?.querySelector<HTMLElement>(
                `#${getSearchResultId(activeResultIndex)}`
            );
            activeResult?.click();
        }
    }, [activeResultIndex, closeSearch, results.length]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                openSearch();
                return;
            }

            if (event.key === 'Escape' && isOpen) {
                event.preventDefault();
                closeSearch();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [closeSearch, isOpen, openSearch]);

    useEffect(() => {
        setActiveResultIndex(-1);
    }, [query, results.length]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleFocusTrap = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !panelRef.current) {
                return;
            }

            const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            ));

            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleFocusTrap);
        return () => document.removeEventListener('keydown', handleFocusTrap);
    }, [isOpen]);

    useEffect(() => {
        if (isOpen || compact) return;

        const currentText = placeholders[placeholderIndex];
        const timeout = setTimeout(() => {
            if (!isDeleting) {
                if (charIndex < currentText.length) {
                    setPlaceholder(currentText.slice(0, charIndex + 1));
                    setCharIndex(charIndex + 1);
                } else {
                    setTimeout(() => setIsDeleting(true), 2000);
                }
            } else if (charIndex > 0) {
                setPlaceholder(currentText.slice(0, charIndex - 1));
                setCharIndex(charIndex - 1);
            } else {
                setIsDeleting(false);
                setPlaceholderIndex((placeholderIndex + 1) % placeholders.length);
            }
        }, isDeleting ? 50 : 100);

        return () => clearTimeout(timeout);
    }, [charIndex, compact, isDeleting, placeholderIndex, isOpen]);

    useEffect(() => {
        if (!isAdminShortcut) {
            return;
        }

        let isMounted = true;

        async function loadEditorAuthStatus() {
            setIsEditorAuthStatusLoading(true);
            setEditorAuthStatusError(null);

            try {
                const response = await fetch('/api/editor-auth', {
                    credentials: 'include',
                    cache: 'no-store',
                });
                const payload = (await response.json().catch(() => null)) as Partial<EditorAuthStatus> & {
                    message?: string;
                } | null;

                if (!response.ok) {
                    throw new Error(payload?.message || '编辑区状态加载失败');
                }

                if (isMounted) {
                    setEditorAuthStatus({
                        configured: Boolean(payload?.configured),
                        authenticated: Boolean(payload?.authenticated),
                        setupEnabled: Boolean(payload?.setupEnabled),
                        setupTokenRequired: Boolean(payload?.setupTokenRequired),
                    });
                }
            } catch (error) {
                if (isMounted) {
                    setEditorAuthStatus(null);
                    setEditorAuthStatusError(
                        error instanceof Error ? error.message : '编辑区状态加载失败'
                    );
                }
            } finally {
                if (isMounted) {
                    setIsEditorAuthStatusLoading(false);
                }
            }
        }

        loadEditorAuthStatus();

        return () => {
            isMounted = false;
        };
    }, [isAdminShortcut]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                closeSearch();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [closeSearch]);

    return (
        <div ref={containerRef} className={cn('relative', className)}>
            {compact ? (
                <button
                    type="button"
                    onClick={openSearch}
                    aria-label="搜索文章和链接"
                    aria-haspopup="dialog"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? COMMAND_SEARCH_PANEL_ID : undefined}
                    className="flex h-[44px] min-h-[44px] w-[44px] items-center justify-center gap-2 rounded-token-input border border-border bg-surface p-0 text-xs font-mono text-subtle transition-colors duration-token-fast hover:border-border-focus hover:bg-surface-elevated"
                >
                    <Search className="h-4 w-4 text-muted" />
                </button>
            ) : (
                <div className="flex min-h-[44px] min-w-[260px] items-center gap-2 rounded-token-input border border-border bg-surface px-3 py-2 text-xs font-mono text-subtle transition-colors duration-token-fast focus-within:border-border-focus focus-within:bg-surface-elevated hover:border-border-focus hover:bg-surface-elevated">
                    <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    <input
                        ref={desktopInputRef}
                        type="text"
                        value={query}
                        onFocus={openSearch}
                        onChange={(e) => {
                            openSearch();
                            setQuery(e.target.value);
                        }}
                        onKeyDown={handleSearchInputKeyDown}
                        placeholder={placeholder || placeholders[0]}
                        role="combobox"
                        aria-label="搜索文章和链接"
                        aria-autocomplete="list"
                        aria-haspopup="dialog"
                        aria-expanded={isOpen}
                        aria-controls={isOpen ? COMMAND_SEARCH_PANEL_ID : undefined}
                        aria-activedescendant={activeResultIndex >= 0 ? getSearchResultId(activeResultIndex) : undefined}
                        className="min-w-0 flex-1 bg-transparent text-left text-muted outline-none placeholder:text-muted"
                    />
                    {query ? (
                        <button
                            type="button"
                            onClick={clearQuery}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-token-card text-subtle transition hover:bg-background hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                            aria-label="清空命令搜索"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    ) : (
                        <kbd className="hidden items-center gap-0.5 rounded-token-badge bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle border border-border-soft sm:inline-flex">
                            Ctrl+K
                        </kbd>
                    )}
                </div>
            )}

            {isOpen && (
                <div
                    ref={panelRef}
                    id={COMMAND_SEARCH_PANEL_ID}
                    role="dialog"
                    aria-modal="true"
                    aria-label="全站搜索"
                    className={cn(
                        'z-token-dropdown overflow-hidden rounded-token-card border border-border bg-surface-elevated shadow-token-lg',
                        compact
                            ? 'fixed left-4 right-4 top-[4.25rem]'
                            : 'absolute top-full left-0 right-0 mt-2 min-w-[360px]'
                    )}
                >
                    {compact && (
                        <div className="flex items-center gap-2 border-b border-border-soft bg-surface px-4 py-3">
                            <Search className="h-4 w-4 text-subtle" />
                            <input
                                ref={panelInputRef}
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleSearchInputKeyDown}
                                placeholder={`搜索文章或链接，输入 ${ADMIN_SHORTCUT} 进编辑区`}
                                aria-label="搜索文章或链接"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-controls={COMMAND_SEARCH_PANEL_ID}
                                aria-expanded={true}
                                aria-activedescendant={activeResultIndex >= 0 ? getSearchResultId(activeResultIndex) : undefined}
                                className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
                                autoFocus
                            />
                            {query ? (
                                <button
                                    type="button"
                                    onClick={clearQuery}
                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card text-subtle transition hover:bg-background hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8 sm:min-w-8"
                                    aria-label="清空命令搜索"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            ) : null}
                            <kbd className="text-[10px] font-mono text-subtle bg-surface px-1.5 py-0.5 rounded-token-badge border border-border-soft">ESC</kbd>
                        </div>
                    )}

                    {isLoading && (
                        <div className="px-4 py-6 text-center text-sm font-mono text-subtle" aria-live="polite">
                            <span className="animate-pulse">搜索中...</span>
                        </div>
                    )}

                    {!isLoading && results.length > 0 && (
                        <div
                            className="max-h-72 overflow-y-auto"
                            role="listbox"
                            aria-label="搜索结果"
                            aria-live="polite"
                        >
                            {results.map((result, index) => (
                                <SearchResultItem
                                    key={`${result.type}-${result.href}-${result.title}`}
                                    id={getSearchResultId(index)}
                                    result={result}
                                    isActive={index === activeResultIndex}
                                    onSelect={closeSearch}
                                    onMouseEnter={() => setActiveResultIndex(index)}
                                />
                            ))}
                        </div>
                    )}

                    {!isLoading && errorMessage && (
                        <div className="px-4 py-6 text-center text-sm font-mono text-danger" role="alert">
                            <span className="text-danger">!</span> {errorMessage}
                        </div>
                    )}

                    {!isLoading && !errorMessage && hasSearchableQuery && !isAdminShortcut && results.length === 0 && (
                        <div className="px-4 py-6 text-center text-sm font-mono text-subtle" aria-live="polite">
                            <span className="text-accent">!</span> 未找到匹配的文章或链接
                        </div>
                    )}

                    {!isLoading && !query && (
                        <div className="px-4 py-3 text-xs font-mono text-subtle border-t border-border-soft">
                            输入关键词搜索文章和链接
                        </div>
                    )}

                    {isAdminShortcut && (
                        <CommandAdminMenu
                            status={editorAuthStatus}
                            isLoading={isEditorAuthStatusLoading}
                            error={editorAuthStatusError}
                            onClose={closeSearch}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
