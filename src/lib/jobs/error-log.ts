type ErrorLike = {
    code?: unknown;
    name?: unknown;
};

/**
 * Operational logs must never echo raw error text: storage and parser errors can
 * embed stored file content. Log a fixed classification (name and, when present,
 * a system error code) instead of the message.
 */
export function describeErrorForLog(error: unknown): string {
    if (error instanceof Error) {
        const code = (error as ErrorLike).code;
        return typeof code === 'string' && code ? `${error.name} (${code})` : error.name;
    }

    return typeof error;
}
