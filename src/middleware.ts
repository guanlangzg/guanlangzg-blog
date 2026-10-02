import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import {
    EDITOR_SESSION_COOKIE,
    getSafeEditorNextPath,
} from '@/lib/editor-auth';
import { getPublicRequestOrigin } from '@/lib/request-origin';
import { THEME_INIT_SCRIPT } from '@/lib/theme-init-script';
import { classifyVpsRequest, PREVIEW_RELEASE_PARAM } from '@/lib/vps-access-policy';

export const runtime = 'nodejs';

const CSP_NONCE_HEADER = 'x-nonce';

const THEME_INIT_SCRIPT_HASH = `'sha256-${createHash('sha256').update(THEME_INIT_SCRIPT).digest('base64')}'`;

interface SecurityHeaders {
    contentSecurityPolicy: string;
    requestHeaders?: Headers;
}

function normalizeCspHeader(value: string): string {
    return value.replace(/\s{2,}/g, ' ').trim();
}

function createNonceContentSecurityPolicy(nonce: string): string {
    const scriptSrc = process.env.NODE_ENV === 'development'
        ? `'self' 'nonce-${nonce}' 'unsafe-eval' ${THEME_INIT_SCRIPT_HASH} https://static.cloudflareinsights.com`
        : `'self' 'nonce-${nonce}' ${THEME_INIT_SCRIPT_HASH} https://static.cloudflareinsights.com`;

    return normalizeCspHeader(`
        default-src 'self';
        script-src ${scriptSrc};
        style-src 'self' 'unsafe-inline';
        img-src 'self' data: blob: https:;
        font-src 'self' data:;
        connect-src 'self' https://cloudflareinsights.com;
        frame-ancestors 'none';
        base-uri 'self';
        form-action 'self'
    `);
}

function createNonceSecurityHeaders(request: NextRequest): SecurityHeaders {
    const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
    const contentSecurityPolicy = createNonceContentSecurityPolicy(nonce);
    const requestHeaders = new Headers(request.headers);

    requestHeaders.set(CSP_NONCE_HEADER, nonce);
    requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);

    return {
        contentSecurityPolicy,
        requestHeaders,
    };
}

function createSecurityHeadersResponse(securityHeaders: SecurityHeaders): NextResponse {
    const response = securityHeaders.requestHeaders
        ? NextResponse.next({
            request: {
                headers: securityHeaders.requestHeaders,
            },
        })
        : NextResponse.next();

    response.headers.set('Content-Security-Policy', securityHeaders.contentSecurityPolicy);

    if (process.env.NODE_ENV === 'production') {
        response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }

    return response;
}

function setSecurityHeaders(response: NextResponse, securityHeaders: SecurityHeaders): NextResponse {
    response.headers.set('Content-Security-Policy', securityHeaders.contentSecurityPolicy);

    if (process.env.NODE_ENV === 'production') {
        response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }

    return response;
}

const PREVIEW_FILES_BASE_PATH = '/api/editor/preview-files';

function isRscRequest(request: NextRequest): boolean {
    return request.headers.get('rsc') === '1'
        || request.headers.get('next-router-prefetch') === '1'
        || request.headers.get('next-router-state-tree') !== null;
}

function createLoginRedirect(request: NextRequest, securityHeaders: SecurityHeaders): NextResponse {
    const { pathname, search } = request.nextUrl;
    const loginUrl = new URL('/editor/login', getPublicRequestOrigin(request));

    loginUrl.searchParams.set('next', getSafeEditorNextPath(`${pathname}${search}`));
    return setSecurityHeaders(NextResponse.redirect(loginUrl), securityHeaders);
}

function createBlockedResponse(
    request: NextRequest,
    securityHeaders: SecurityHeaders,
    target: 'document' | 'resource'
): NextResponse {
    const hasSessionCookie = Boolean(request.cookies.get(EDITOR_SESSION_COOKIE)?.value);

    if (target === 'document') {
        // A signed-in admin lands on the management entry instead of the old dynamic page:
        // reader content only exists on GitHub Pages or inside a version-bound preview.
        return hasSessionCookie
            ? setSecurityHeaders(
                NextResponse.redirect(new URL('/editor', getPublicRequestOrigin(request))),
                securityHeaders
            )
            : createLoginRedirect(request, securityHeaders);
    }

    const status = hasSessionCookie ? 404 : 401;
    const response = new NextResponse(hasSessionCookie ? 'Not Found' : 'Unauthorized', {
        status,
        headers: {
            'Cache-Control': 'private, no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow',
        },
    });

    return setSecurityHeaders(response, securityHeaders);
}

/**
 * Rewrites a version-bound preview request to the sealed artifact service. The release ID
 * always comes from the request URL (path or previewRelease), never from the active preview
 * cookie, and the sealed per-page CSP is left untouched by not injecting a management nonce.
 */
function createPreviewRewrite(
    request: NextRequest,
    securityHeaders: SecurityHeaders,
    decision: { releaseId: string; artifactPath: string }
): NextResponse {
    if (!request.cookies.get(EDITOR_SESSION_COOKIE)?.value) {
        return createBlockedResponse(request, securityHeaders, 'resource');
    }

    // Built from the raw URL instead of nextUrl.clone(): cloning re-applies trailing-slash
    // normalization and would turn a sealed file path into a directory path.
    const url = new URL(request.url);

    url.pathname = `${PREVIEW_FILES_BASE_PATH}/${decision.releaseId}/${decision.artifactPath}`;
    url.searchParams.set(PREVIEW_RELEASE_PARAM, decision.releaseId);

    const response = NextResponse.rewrite(url);

    if (process.env.NODE_ENV === 'production') {
        response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }

    return response;
}

export function middleware(request: NextRequest) {
    const securityHeaders = createNonceSecurityHeaders(request);
    const decision = classifyVpsRequest({
        pathname: request.nextUrl.pathname,
        previewRelease: request.nextUrl.searchParams.get(PREVIEW_RELEASE_PARAM),
        isRscRequest: isRscRequest(request),
    });

    if (decision.kind === 'preview') {
        return createPreviewRewrite(request, securityHeaders, decision);
    }

    if (decision.kind === 'blocked') {
        return createBlockedResponse(request, securityHeaders, decision.target);
    }

    const response = createSecurityHeadersResponse(securityHeaders);

    if (decision.kind === 'allow') {
        return response;
    }

    return request.cookies.get(EDITOR_SESSION_COOKIE)?.value
        ? response
        : createLoginRedirect(request, securityHeaders);
}

export const config = {
    matcher: [
        // Prefetch and HEAD requests are deliberately included: excluding them would let a
        // crafted header skip the content boundary entirely.
        '/((?!api|_next/static|_next/image|favicon.ico|favicon-16.png|favicon-32.png|favicon-48.png|favicon-64.png|guanlan-logo.png).*)',
    ],
};
