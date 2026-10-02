import type { NextRequest } from 'next/server';
import { getRuntimeTrustedProxyIps } from '@/lib/app-runtime-config';

function getFirstForwardedValue(value: string | null): string | null {
    const firstValue = value?.split(',')[0]?.trim();
    return firstValue || null;
}

function normalizeProtocol(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const normalized = value.replace(/:$/, '').toLowerCase();
    return normalized === 'http' || normalized === 'https' ? normalized : null;
}

// Single source of truth for request origin resolution. Trusted proxy IPs come
// from the runtime config (stored settings first, env fallback), so middleware
// and editor API auth resolve origins identically.
export function getPublicRequestOrigin(request: NextRequest): string {
    const forwardedHost = getFirstForwardedValue(request.headers.get('x-forwarded-host'));
    const forwardedProto = normalizeProtocol(getFirstForwardedValue(request.headers.get('x-forwarded-proto')));
    const trustForwardedHeaders = getRuntimeTrustedProxyIps().length > 0;
    const host = trustForwardedHeaders && forwardedHost
        ? forwardedHost
        : request.headers.get('host') ?? request.nextUrl.host;
    const protocol = trustForwardedHeaders && forwardedProto
        ? forwardedProto
        : request.nextUrl.protocol.replace(/:$/, '');

    return `${protocol}://${host}`;
}
