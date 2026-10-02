import { getRuntimeCookieSecure } from '@/lib/app-runtime-config';
import { EDITOR_SESSION_MAX_AGE } from '@/lib/editor-auth';

export function getEditorCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: getRuntimeCookieSecure(),
        path: '/',
        maxAge: EDITOR_SESSION_MAX_AGE,
    };
}

export function getEditorCsrfCookieOptions() {
    return {
        httpOnly: false,
        sameSite: 'lax' as const,
        secure: getRuntimeCookieSecure(),
        path: '/',
        maxAge: EDITOR_SESSION_MAX_AGE,
    };
}
