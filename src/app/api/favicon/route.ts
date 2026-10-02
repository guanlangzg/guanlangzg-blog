import { NextRequest } from 'next/server';

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#f8e8df"/><path d="M4 8h8" stroke="#b85c38" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function getDomain(value: string | null): string | null {
    const domain = value?.trim().toLowerCase();

    if (!domain || domain.length > 253) {
        return null;
    }

    return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

function createFallbackResponse(): Response {
    return new Response(FALLBACK_SVG, {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=86400',
        },
    });
}

export async function GET(request: NextRequest) {
    const domain = getDomain(request.nextUrl.searchParams.get('domain'));

    if (!domain) {
        return createFallbackResponse();
    }

    try {
        const response = await fetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`, {
            signal: AbortSignal.timeout(2500),
            next: { revalidate: 86400 },
        });
        const contentType = response.headers.get('content-type') || 'image/x-icon';

        if (response.ok && response.body && contentType.startsWith('image/')) {
            return new Response(response.body, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=86400',
                },
            });
        }
    } catch {
        return createFallbackResponse();
    }

    return createFallbackResponse();
}
