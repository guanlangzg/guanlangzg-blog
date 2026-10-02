function isLocalHttpHost(hostname: string): boolean {
    // WHATWG URL serializes IPv6 hostnames with brackets, e.g. '[::1]'.
    const normalized = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;

    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isSafeExternalUrl(value: string): boolean {
    try {
        const url = new URL(value.trim());

        if (url.protocol === 'https:') {
            return true;
        }

        if (process.env.NODE_ENV !== 'production' && url.protocol === 'http:') {
            return isLocalHttpHost(url.hostname);
        }

        return false;
    } catch {
        return false;
    }
}

export function normalizeSafeExternalUrl(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed && isSafeExternalUrl(trimmed) ? trimmed : null;
}
