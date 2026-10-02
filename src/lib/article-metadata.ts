import type {
    ArticleKind,
    ArticleStatus,
    ArticleTemplateGroup,
    QualityRuleSeverity,
} from '@/app/types/article';

export const ARTICLE_KIND_OPTIONS: Array<{ value: ArticleKind; label: string }> = [
    { value: 'essay', label: '观点随笔' },
    { value: 'guide', label: '技术教程' },
    { value: 'deep-dive', label: '研究长文' },
    { value: 'til', label: '短笔记' },
    { value: 'debug', label: '排障' },
    { value: 'project', label: '项目案例' },
    { value: 'resource', label: '资源清单' },
    { value: 'link', label: '链接短评' },
    { value: 'review', label: '读书评注' },
    { value: 'release', label: '版本记录' },
];

export const ARTICLE_STATUS_OPTIONS: Array<{ value: ArticleStatus; label: string }> = [
    { value: 'draft', label: '草稿' },
    { value: 'seedling', label: '幼苗' },
    { value: 'published', label: '已发布' },
    { value: 'evergreen', label: '常青' },
    { value: 'archived', label: '归档' },
];

export const TEMPLATE_GROUP_OPTIONS: Array<{ value: ArticleTemplateGroup; label: string }> = [
    { value: 'quick', label: '快速沉淀' },
    { value: 'deep', label: '深度资产' },
    { value: 'review', label: '经验复盘' },
    { value: 'entry', label: '导航入口' },
];

export const QUALITY_SEVERITY_LABELS: Record<QualityRuleSeverity, string> = {
    blocking: '阻塞',
    warning: '建议',
    suggestion: '提示',
};

const ARTICLE_KINDS = new Set<ArticleKind>(ARTICLE_KIND_OPTIONS.map((option) => option.value));
const ARTICLE_STATUSES = new Set<ArticleStatus>(ARTICLE_STATUS_OPTIONS.map((option) => option.value));

export function normalizeArticleKind(value: unknown, fallback: ArticleKind = 'essay'): ArticleKind {
    return typeof value === 'string' && ARTICLE_KINDS.has(value as ArticleKind)
        ? value as ArticleKind
        : fallback;
}

export function normalizeArticleStatus(
    value: unknown,
    fallback: ArticleStatus = 'published'
): ArticleStatus {
    return typeof value === 'string' && ARTICLE_STATUSES.has(value as ArticleStatus)
        ? value as ArticleStatus
        : fallback;
}

export function getArticleKindLabel(kind?: ArticleKind): string {
    return ARTICLE_KIND_OPTIONS.find((option) => option.value === kind)?.label || '观点随笔';
}

export function getArticleStatusLabel(status?: ArticleStatus): string {
    return ARTICLE_STATUS_OPTIONS.find((option) => option.value === status)?.label || '已发布';
}

export function isPublicArticleStatus(status?: ArticleStatus): boolean {
    return status !== 'draft';
}
