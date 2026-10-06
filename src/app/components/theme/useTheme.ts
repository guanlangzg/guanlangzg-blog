'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
    // The server cannot read the stored preference, so the first render must
    // stay on 'system' to match the server markup; the stored value is adopted
    // after mount (the pre-paint script already applied its dark class).
    const [preference, setPreference] = useState<ThemePreference>('system');
    const hasAppliedFirstPreference = useRef(false);

    useEffect(() => {
        setPreference(readStoredPreference());
    }, []);

    useEffect(() => {
        // The first effect pass still sees the 'system' default while the
        // document may already be dark; re-read the stored preference once so
        // the class list is not toggled back before the state catches up.
        const effectivePreference = hasAppliedFirstPreference.current
            ? preference
            : readStoredPreference();
        hasAppliedFirstPreference.current = true;

        const root = document.documentElement;

        const apply = () => {
            root.classList.toggle('dark', isDarkPreference(effectivePreference));
        };

        apply();

        if (effectivePreference !== 'system' || typeof window.matchMedia !== 'function') {
            return;
        }

        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const handleSystemChange = () => apply();

        media.addEventListener('change', handleSystemChange);

        return () => media.removeEventListener('change', handleSystemChange);
    }, [preference]);

    const setTheme = useCallback((next: ThemePreference) => {
        window.localStorage.setItem(THEME_STORAGE_KEY, next === 'system' ? '' : next);
        setPreference(next);
    }, []);

    return { preference, setTheme };
}
