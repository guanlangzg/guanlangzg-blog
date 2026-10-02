import { normalizeSearchQuery } from '@/lib/search-query';
import type { PublicSearchDocument } from '@/public-site/types';

function normalizeSearchText(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

export function tokenizePublicSearchText(value: string): string[] {
    const normalized = normalizeSearchText(value);
    const terms = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
    const tokens = new Set<string>(terms);
    for (const term of terms) {
        if (/\p{Script=Han}/u.test(term)) {
            for (let index = 0; index < term.length - 1; index += 1) tokens.add(term.slice(index, index + 2));
            if (term.length > 2) for (let index = 0; index < term.length; index += 1) tokens.add(term[index]);
        }
    }
    return [...tokens];
}

export function createPublicSearchDocument(input: Omit<PublicSearchDocument, 'normalizedText' | 'tokens'>): PublicSearchDocument {
    const normalizedText = normalizeSearchText(`${input.title} ${input.description} ${input.tags.join(' ')} ${input.text}`);
    return { ...input, normalizedText, tokens: tokenizePublicSearchText(normalizedText) };
}

export function matchesPublicSearchDocument(document: PublicSearchDocument, query: string): boolean {
    const normalizedQuery = normalizeSearchQuery(normalizeSearchText(query));
    if (!normalizedQuery) return false;
    if (document.normalizedText.includes(normalizedQuery)) return true;
    const tokens = new Set(document.tokens);
    const queryTokens = tokenizePublicSearchText(normalizedQuery);
    return queryTokens.length > 0 && queryTokens.every((token) => tokens.has(token));
}
