import type { NextRequest } from 'next/server';
import { getRuntimeTrustedProxyIps } from '@/lib/app-runtime-config';
import { isLocalRuntime } from '@/lib/runtime-environment';

const LOCAL_CLIENT_ID = 'local';
const UNKNOWN_CLIENT_ID = 'unknown';

const warnedSpoofableClientIdReasons = new Set<string>();

function warnAboutSpoofableClientId(reason: string): void {
    if (isLocalRuntime() || warnedSpoofableClientIdReasons.has(reason)) {
        return;
    }

    warnedSpoofableClientIdReasons.add(reason);
    console.warn(
        `[request-client] ${reason} lets clients spoof their own rate-limit identity. ` +
        'Editor login brute-force protection is weakened. Configure explicit TRUSTED_PROXY_IPS in production.'
    );
}

export function getTrustedProxyIps(): Set<string> | null {
    const configuredIps = getRuntimeTrustedProxyIps();

    if (configuredIps.length === 0) {
        return null;
    }

    return new Set(configuredIps);
}

const CLIENT_IP_HEADERS = [
    'cf-connecting-ip',
    'x-real-ip',
    'true-client-ip',
];

function normalizeClientPart(value: string | null): string | null {
    const normalized = value?.split(',')[0]?.trim();
    return normalized || null;
}

function isSkipIpValidationEnabled(): boolean {
    return process.env.SKIP_IP_VALIDATION === 'true';
}

// Rate limiting keys on this identity, so an unreliable id means brute-force
// protection is bypassable. `SKIP_IP_VALIDATION` and a `*` trusted-proxy entry
// are explicit operator opt-ins and stay supported, but they must be noisy in
// production instead of silently degrading the login limiter.
export function isRequestClientIdReliable(): boolean {
    if (isSkipIpValidationEnabled()) {
        warnAboutSpoofableClientId('SKIP_IP_VALIDATION=true');
        return true;
    }

    const trustedProxyIps = getTrustedProxyIps();

    if (trustedProxyIps) {
        if (trustedProxyIps.has('*')) {
            warnAboutSpoofableClientId('TRUSTED_PROXY_IPS=*');
        }

        return true;
    }

    return isLocalRuntime();
}

function getForwardedForParts(request: NextRequest): string[] {
    return request.headers.get('x-forwarded-for')
        ?.split(',')
        .map((part) => part.trim())
        .filter(Boolean) ?? [];
}

function getTrustedForwardedClientId(request: NextRequest, trustedProxyIps: Set<string>): string | null {
    if (trustedProxyIps.has('*')) {
        return getHeaderClientId(request);
    }

    // Walk right to left: each trusted-proxy entry is a hop, so the first
    // non-trusted entry is the client as recorded by the last trusted hop.
    // Taking the leftmost entry instead would let clients spoof their identity
    // through the XFF header; requiring two entries breaks single-proxy setups
    // where every client collapses into one shared rate-limit bucket.
    const forwardedForParts = getForwardedForParts(request);

    for (let index = forwardedForParts.length - 1; index >= 0; index -= 1) {
        const part = forwardedForParts[index];

        if (!trustedProxyIps.has(part)) {
            return part;
        }
    }

    return null;
}

function getHeaderClientId(request: NextRequest): string | null {
    const forwardedForClient = normalizeClientPart(request.headers.get('x-forwarded-for'));

    if (forwardedForClient) {
        return forwardedForClient;
    }

    for (const header of CLIENT_IP_HEADERS) {
        const value = normalizeClientPart(request.headers.get(header));
        if (value) {
            return value;
        }
    }

    return null;
}

export function getRequestClientId(request: NextRequest): string {
    if (isSkipIpValidationEnabled()) {
        return getHeaderClientId(request) ?? UNKNOWN_CLIENT_ID;
    }

    const trustedProxyIps = getTrustedProxyIps();

    if (trustedProxyIps) {
        return getTrustedForwardedClientId(request, trustedProxyIps) ?? UNKNOWN_CLIENT_ID;
    }

    return process.env.NODE_ENV === 'test' ? LOCAL_CLIENT_ID : UNKNOWN_CLIENT_ID;
}
