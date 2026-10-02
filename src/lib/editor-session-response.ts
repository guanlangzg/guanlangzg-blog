import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
    EDITOR_CSRF_COOKIE,
    EDITOR_SESSION_COOKIE,
} from '@/lib/editor-auth';
import {
    getEditorCookieOptions,
    getEditorCsrfCookieOptions,
} from '@/lib/editor-auth-cookies';

export function setEditorSessionCookies(response: NextResponse, sessionValue: string): NextResponse {
    const csrfToken = randomBytes(32).toString('hex');

    response.cookies.set(
        EDITOR_SESSION_COOKIE,
        sessionValue,
        getEditorCookieOptions()
    );
    response.cookies.set(
        EDITOR_CSRF_COOKIE,
        csrfToken,
        getEditorCsrfCookieOptions()
    );

    return response;
}

export function createEditorSessionResponse(sessionValue: string): NextResponse {
    return setEditorSessionCookies(NextResponse.json({ success: true }), sessionValue);
}

export function clearEditorSessionCookie(response: NextResponse): NextResponse {
    response.cookies.set(EDITOR_SESSION_COOKIE, '', {
        ...getEditorCookieOptions(),
        maxAge: 0,
    });
    response.cookies.set(EDITOR_CSRF_COOKIE, '', {
        ...getEditorCsrfCookieOptions(),
        maxAge: 0,
    });

    return response;
}
