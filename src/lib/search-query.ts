export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 80;

export function normalizeSearchQuery(value: string | null | undefined): string {
    return (value ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .slice(0, SEARCH_QUERY_MAX_LENGTH);
}

export function isSearchQueryAllowed(query: string): boolean {
    return query.length >= SEARCH_QUERY_MIN_LENGTH;
}
