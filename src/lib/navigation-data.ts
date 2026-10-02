import type { Category, Tool } from '@/app/types/navigation';
import { isSafeExternalUrl } from '@/lib/url-safety';

type UnknownRecord = Record<string, unknown>;

export class NavigationDataParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NavigationDataParseError';
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function createSlug(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

export function isValidNavigationUrl(value: string): boolean {
    return isSafeExternalUrl(value);
}

function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(isNonEmptyString)
        .map((tag) => tag.trim())
        .filter(Boolean);
}

function normalizeToolOrThrow(value: unknown): Tool {
    if (!value || typeof value !== 'object') {
        throw new NavigationDataParseError('导航工具必须是对象。');
    }

    const tool = value as UnknownRecord;

    if (
        !isNonEmptyString(tool.icon) ||
        !isNonEmptyString(tool.title) ||
        !isNonEmptyString(tool.description) ||
        !isNonEmptyString(tool.url) ||
        !isValidNavigationUrl(tool.url)
    ) {
        throw new NavigationDataParseError('导航工具必须包含 icon、title、description 和 HTTPS URL。');
    }

    const tags = normalizeTags(tool.tags);

    if (tags.length === 0) {
        throw new NavigationDataParseError('导航工具必须至少包含一个 tag。');
    }

    return {
        icon: tool.icon.trim(),
        title: tool.title.trim(),
        description: tool.description.trim(),
        url: tool.url.trim(),
        tags,
    };
}

function normalizeCategoryOrThrow(value: unknown): Category {
    if (!value || typeof value !== 'object') {
        throw new NavigationDataParseError('导航分类必须是对象。');
    }

    const category = value as UnknownRecord;

    if (
        !isNonEmptyString(category.name) ||
        !isNonEmptyString(category.icon) ||
        !Array.isArray(category.tools)
    ) {
        throw new NavigationDataParseError('导航分类必须包含 name、icon 和 tools 数组。');
    }

    const tools = category.tools.map((tool) => normalizeToolOrThrow(tool));

    const slugSource = isNonEmptyString(category.slug) ? category.slug : category.name;
    const slug = createSlug(slugSource);

    if (!slug) {
        throw new NavigationDataParseError('导航分类必须有合法的 slug。');
    }

    return {
        name: category.name.trim(),
        icon: category.icon.trim(),
        slug,
        tools,
    };
}

export function parseNavigationDataOrThrow(input: unknown): Category[] {
    if (!Array.isArray(input)) {
        throw new NavigationDataParseError('导航数据必须是数组。');
    }

    const slugs = new Set<string>();
    const categories = input.map((item) => normalizeCategoryOrThrow(item));

    for (const category of categories) {
        if (slugs.has(category.slug)) {
            throw new NavigationDataParseError(`导航分类 slug 重复：${category.slug}`);
        }

        slugs.add(category.slug);
    }

    return categories;
}

export function parseNavigationData(input: unknown): Category[] | null {
    try {
        return parseNavigationDataOrThrow(input);
    } catch {
        return null;
    }
}
