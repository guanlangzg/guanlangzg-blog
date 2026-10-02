import { isRecord } from '@/lib/article-data';

export interface SiteSettings {
    siteName: string;
    siteDescription: string;
    workspaceLabel: string;
    heroTitleLineOne: string;
    heroTitleLineTwo: string;
    heroDescription: string;
    showIntroCard: boolean;
    introCardEyebrow: string;
    introCardTitle: string;
    introCardDescription: string;
    introCardMetaOneLabel: string;
    introCardMetaOneValue: string;
    introCardMetaTwoLabel: string;
    introCardMetaTwoValue: string;
    introCardMetaThreeLabel: string;
    introCardMetaThreeValue: string;
    introCardStartLabel: string;
}

export class SiteSettingsParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SiteSettingsParseError';
    }
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
    siteName: '观澜志',
    siteDescription: '记录值得回看的文章与实用导航。',
    workspaceLabel: '观澜志 / 文章与导航',
    heroTitleLineOne: '记录值得回看的内容，',
    heroTitleLineTwo: '整理实用的知识与导航',
    heroDescription:
        '观澜志收录公开文章与常用导航，帮助读者查找、阅读和整理信息。',
    showIntroCard: true,
    introCardEyebrow: '观澜志',
    introCardTitle: '文章与导航，一处查阅',
    introCardDescription:
        '浏览站点公开文章，或从分类导航中查找常用网站与参考资料。',
    introCardMetaOneLabel: '内容',
    introCardMetaOneValue: '公开文章与实用导航',
    introCardMetaTwoLabel: '文章',
    introCardMetaTwoValue: '按主题查阅文章与笔记',
    introCardMetaThreeLabel: '导航',
    introCardMetaThreeValue: '按分类查找网站与工具',
    introCardStartLabel: '开始浏览',
};

export const SITE_SETTING_KEYS = [
    'siteName',
    'siteDescription',
    'workspaceLabel',
    'heroTitleLineOne',
    'heroTitleLineTwo',
    'heroDescription',
    'introCardEyebrow',
    'introCardTitle',
    'introCardDescription',
    'introCardMetaOneLabel',
    'introCardMetaOneValue',
    'introCardMetaTwoLabel',
    'introCardMetaTwoValue',
    'introCardMetaThreeLabel',
    'introCardMetaThreeValue',
    'introCardStartLabel',
] as const;

const LEGACY_SETTING_KEYS = [
    'siteName',
    'siteDescription',
    'workspaceLabel',
    'heroTitleLineOne',
    'heroTitleLineTwo',
    'heroDescription',
] as const;

const DEFAULTED_SETTING_KEYS = [
    'introCardEyebrow',
    'introCardTitle',
    'introCardDescription',
    'introCardMetaOneLabel',
    'introCardMetaOneValue',
    'introCardMetaTwoLabel',
    'introCardMetaTwoValue',
    'introCardMetaThreeLabel',
    'introCardMetaThreeValue',
    'introCardStartLabel',
] as const;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringWithDefault(value: unknown, defaultValue: string): string | null {
    if (value === undefined) {
        return defaultValue;
    }

    return normalizeString(value);
}

function normalizeBooleanWithDefault(value: unknown, defaultValue: boolean): boolean | null {
    if (value === undefined) {
        return defaultValue;
    }

    return typeof value === 'boolean' ? value : null;
}

export function parseSiteSettingsOrThrow(value: unknown): SiteSettings {
    if (!isRecord(value)) {
        throw new SiteSettingsParseError('站点设置必须是对象。');
    }

    const nextSettings = {} as SiteSettings;

    for (const key of LEGACY_SETTING_KEYS) {
        const normalized = normalizeString(value[key]);

        if (!normalized) {
            throw new SiteSettingsParseError(`站点设置必须包含非空的 ${key}。`);
        }

        nextSettings[key] = normalized;
    }

    for (const key of DEFAULTED_SETTING_KEYS) {
        const normalized = normalizeStringWithDefault(value[key], DEFAULT_SITE_SETTINGS[key]);

        if (!normalized) {
            throw new SiteSettingsParseError(`站点设置必须包含非空的 ${key}。`);
        }

        nextSettings[key] = normalized;
    }

    const showIntroCard = normalizeBooleanWithDefault(value.showIntroCard, DEFAULT_SITE_SETTINGS.showIntroCard);

    if (showIntroCard === null) {
        throw new SiteSettingsParseError('站点设置 showIntroCard 存在时必须是布尔值。');
    }

    nextSettings.showIntroCard = showIntroCard;

    return nextSettings;
}

export function parseSiteSettings(value: unknown): SiteSettings | null {
    try {
        return parseSiteSettingsOrThrow(value);
    } catch {
        return null;
    }
}

export function createDefaultSiteSettings(): SiteSettings {
    return { ...DEFAULT_SITE_SETTINGS };
}
