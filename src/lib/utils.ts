export function cn(...inputs: (string | undefined | null | false)[]): string {
    return inputs.filter(Boolean).join(' ');
}

export function normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
