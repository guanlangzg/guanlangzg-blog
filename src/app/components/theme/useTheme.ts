'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'theme';

function readStoredPreference(): ThemePreference {
    if (typeof window === 'undefined') {
        return 'system';
    }

    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

    return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function isDarkPreference(preference: ThemePreference): boolean {
    if (preference === 'dark') {
        return true;
    }

    if (preference === 'light') {
        return false;
    }

    return typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false;
}

export function useTheme() {
    const [preference, setPreference] = useState<ThemePreference>(readStoredPreference);

    useEffect(() => {
        const root = document.documentElement;

        const apply = () => {
            root.classList.toggle('dark', isDarkPreference(preference));
        };

        apply();

        if (typeof window.matchMedia !== 'function') {
            return;
        }

        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const handleSystemChange = () => {
            if (preference === 'system') {
                apply();
            }
        };

        media.addEventListener('change', handleSystemChange);

        return () => media.removeEventListener('change', handleSystemChange);
    }, [preference]);

    const setTheme = useCallback((next: ThemePreference) => {
        window.localStorage.setItem(THEME_STORAGE_KEY, next === 'system' ? '' : next);
        setPreference(next);
    }, []);

    return { preference, setTheme };
}
