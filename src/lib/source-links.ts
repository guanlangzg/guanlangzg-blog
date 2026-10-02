import type { ArticleRevisionNote, ArticleSourceLink } from '@/app/types/article';
import { normalizeSafeExternalUrl } from '@/lib/url-safety';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function normalizeSourceLinks(value: unknown): ArticleSourceLink[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') {
            return [];
        }

        const title = item.title.trim();
        const url = normalizeSafeExternalUrl(item.url);

        if (!title || !url) {
            return [];
        }

        return [{
            title,
            url,
            ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
        }];
    });
}

export function normalizeRevisionNotes(value: unknown): ArticleRevisionNote[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.date !== 'string' || typeof item.note !== 'string') {
            return [];
        }

        const date = item.date.trim();
        const note = item.note.trim();

        if (!date || !note) {
            return [];
        }

        return [{ date, note }];
    });
}
