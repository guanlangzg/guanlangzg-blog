'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme, type ThemePreference } from './useTheme';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
    const { preference, setTheme } = useTheme();

    return (
        <div
            role="group"
            aria-label="主题切换"
            className="flex items-center gap-1 rounded-token-input border border-border bg-surface p-1"
        >
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const isActive = preference === value;

                return (
                    <button
                        key={value}
                        type="button"
                        onClick={() => setTheme(value)}
                        aria-pressed={isActive}
                        aria-label={label}
                        title={label}
                        className={cn(
                            'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-token-button px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-8',
                            isActive
                                ? 'bg-accent-100 text-accent-900'
                                : 'text-subtle hover:bg-background hover:text-fg'
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {!compact ? <span className="hidden sm:inline">{label}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}
