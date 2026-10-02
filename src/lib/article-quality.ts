import type {
    ArticleKind,
    ArticleSourceLink,
    ArticleStatus,
    ArticleTemplate,
    QualityRuleSeverity,
} from '@/app/types/article';
import { isPublicArticleStatus } from '@/lib/article-metadata';
import { isSafeExternalUrl } from '@/lib/url-safety';

export interface MarkdownHeading {
    level: number;
    text: string;
    id: string;
    index: number;
}

export interface ArticleQualityInput {
    title: string;
    slug?: string;
    date: string;
    updatedDate?: string;
    description: string;
    tags: string[];
    content: string;
    kind?: ArticleKind;
    status?: ArticleStatus;
    category?: string;
    featured?: boolean;
    sourceLinks?: ArticleSourceLink[];
}

export interface ArticleQualityCheck {
    id: string;
    label: string;
    severity: QualityRuleSeverity;
    passed: boolean;
}

export type ArticleWorkflowState = 'draft' | 'needs-fix' | 'ready' | 'published';

export interface ArticleWorkflowSummary {
    state: ArticleWorkflowState;
    blockingChecks: ArticleQualityCheck[];
    warningChecks: ArticleQualityCheck[];
    failedChecks: ArticleQualityCheck[];
}

export type ArticleQualityField =
    | 'title'
    | 'date'
    | 'updatedDate'
    | 'description'
    | 'tags'
    | 'category'
    | 'status'
    | 'featured'
    | 'sourceLinks'
    | 'content';

const SECTION_ALIASES: Record<string, string[]> = {
    参考资料: ['来源', 'References', '参考链接'],
    验证: ['验证记录', '验证方式', '测试'],
    总结: ['结论', '收束'],
    根因: ['原因', 'Root Cause'],
};

export function countMarkdownWords(value: string): number {
    const content = value
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/[#>*_[\]()!-]/g, ' ');
    const cjkCount = content.match(/[\u4e00-\u9fff]/g)?.length || 0;
    const wordCount = content
        .replace(/[\u4e00-\u9fff]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

    return cjkCount + wordCount;
}

export function getMarkdownHeadings(content: string, maxLevel = 4): MarkdownHeading[] {
    const headings: MarkdownHeading[] = [];
    const allocateHeadingId = createMarkdownHeadingIdAllocator();
    let index = 0;

    for (const line of content.split('\n')) {
        const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim());

        if (match && match[1].length <= maxLevel) {
            headings.push({
                level: match[1].length,
                text: match[2],
                id: allocateHeadingId(match[2]),
                index,
            });
        }

        index += line.length + 1;
    }

    return headings;
}

export function createMarkdownHeadingId(text: string): string {
    return encodeURIComponent(getRenderedHeadingText(text) || 'section');
}

export function createMarkdownHeadingIdAllocator(): (text: string) => string {
    const counts = new Map<string, number>();

    return (text: string) => {
        const baseId = createMarkdownHeadingId(text);
        const count = counts.get(baseId) || 0;

        counts.set(baseId, count + 1);

        return count === 0 ? baseId : `${baseId}-${count + 1}`;
    };
}

export function isFirstMarkdownH1DuplicateTitle(content: string, title?: string): boolean {
    if (!title?.trim()) {
        return false;
    }

    const firstHeading = getMarkdownHeadings(content)[0];

    return Boolean(firstHeading?.level === 1 && firstHeading.id === createMarkdownHeadingId(title));
}

function getRenderedHeadingText(text: string): string {
    return text
        .trim()
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/~~([^~]*)~~/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, '$1')
        .trim();
}

export function hasRequiredSection(headings: MarkdownHeading[], section: string): boolean {
    const normalizedSection = normalizeHeadingText(section);
    const aliases = [section, ...(SECTION_ALIASES[section] || [])].map(normalizeHeadingText);

    return headings.some((heading) => {
        const normalizedHeading = normalizeHeadingText(heading.text);

        return normalizedHeading === normalizedSection ||
            aliases.some((alias) => normalizedHeading.includes(alias));
    });
}

export function getArticleQualityChecks(
    article: ArticleQualityInput,
    template?: ArticleTemplate
): ArticleQualityCheck[] {
    const headings = getMarkdownHeadings(article.content);
    const descriptionLength = article.description.trim().length;
    const h1Count = headings.filter((heading) => heading.level === 1).length;
    const hasUntypedCodeBlock = /```(?:\s*\n|$)/.test(article.content);
    const hasUnsafeSourceUrl = article.sourceLinks?.some((source) => {
        const url = source.url.trim();

        return Boolean(url) && !isSafeExternalUrl(url);
    }) || false;
    const checks: ArticleQualityCheck[] = [
        {
            id: 'title-required',
            label: '标题已填写',
            severity: 'blocking',
            passed: article.title.trim().length > 0,
        },
        {
            id: 'date-valid',
            label: '发布日期有效',
            severity: 'blocking',
            passed: isValidDate(article.date),
        },
        {
            id: 'published-description',
            label: '公开文章有描述',
            severity: 'blocking',
            passed: !isPublicArticleStatus(article.status) || article.description.trim().length > 0,
        },
        {
            id: 'description-length',
            label: '描述控制在 30-120 字',
            severity: 'warning',
            passed: descriptionLength >= 30 && descriptionLength <= 120,
        },
        {
            id: 'tags-present',
            label: '至少有 1 个标签',
            severity: 'warning',
            passed: article.tags.length > 0,
        },
        {
            id: 'category-present',
            label: '已设置主分类',
            severity: 'warning',
            passed: Boolean(article.category?.trim()),
        },
        {
            id: 'h1-limit',
            label: '正文最多 1 个 H1',
            severity: 'suggestion',
            passed: h1Count <= 1,
        },
        {
            id: 'code-language',
            label: '代码块声明语言',
            severity: 'suggestion',
            passed: !hasUntypedCodeBlock,
        },
        {
            id: 'source-url-valid',
            label: '参考资料链接安全有效',
            severity: 'blocking',
            passed: !hasUnsafeSourceUrl,
        },
    ];

    for (const section of template?.requiredSections || []) {
        checks.push({
            id: `required-section-${normalizeHeadingText(section)}`,
            label: `包含「${section}」章节`,
            severity: 'warning',
            passed: hasRequiredSection(headings, section),
        });
    }

    if (article.kind === 'deep-dive' || article.kind === 'resource' || article.kind === 'review') {
        checks.push({
            id: 'sources-for-research',
            label: '研究/资源类文章有参考资料',
            severity: 'warning',
            passed: hasRequiredSection(headings, '参考资料') || /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(article.content),
        });
    }

    if (article.featured) {
        checks.push({
            id: 'featured-public',
            label: '精选内容不是草稿',
            severity: 'blocking',
            passed: article.status === 'published' || article.status === 'evergreen',
        });
    }

    if (article.status === 'evergreen') {
        checks.push({
            id: 'evergreen-updated-date',
            label: '常青文章有修订日期',
            severity: 'warning',
            passed: Boolean(article.updatedDate?.trim()),
        });
    }

    return checks;
}

export function getArticleSaveBlockingChecks(
    article: ArticleQualityInput,
    template?: ArticleTemplate
): ArticleQualityCheck[] {
    const failedBlockingChecks = getArticleQualityChecks(article, template)
        .filter((check) => check.severity === 'blocking' && !check.passed);

    if (isPublicArticleStatus(article.status)) {
        return failedBlockingChecks;
    }

    return failedBlockingChecks.filter((check) =>
        check.id === 'date-valid' || check.id === 'source-url-valid'
    );
}

export function getArticleWorkflowSummary(article: ArticleQualityInput): ArticleWorkflowSummary {
    const status = article.status || 'published';
    const publishCandidate = isPublicArticleStatus(status)
        ? article
        : { ...article, status: 'published' as const };
    const failedChecks = getArticleQualityChecks(publishCandidate)
        .filter((check) => !check.passed);
    const blockingChecks = failedChecks.filter((check) => check.severity === 'blocking');
    const warningChecks = failedChecks.filter((check) => check.severity === 'warning');

    if (isPublicArticleStatus(status)) {
        return {
            state: 'published',
            blockingChecks,
            warningChecks,
            failedChecks,
        };
    }

    if (blockingChecks.length > 0) {
        return {
            state: 'needs-fix',
            blockingChecks,
            warningChecks,
            failedChecks,
        };
    }

    return {
        state: 'ready',
        blockingChecks,
        warningChecks,
        failedChecks,
    };
}

export function matchesArticleWorkflowState(article: ArticleQualityInput, state: ArticleWorkflowState): boolean {
    const status = article.status || 'published';

    if (state === 'draft') {
        return status === 'draft';
    }

    return getArticleWorkflowSummary(article).state === state;
}

export function getFrontmatterFieldQualityChecks(
    checks: ArticleQualityCheck[]
): Partial<Record<ArticleQualityField, ArticleQualityCheck[]>> {
    const result: Partial<Record<ArticleQualityField, ArticleQualityCheck[]>> = {};

    for (const check of checks) {
        const field = getArticleQualityField(check.id);

        if (!field || check.passed) {
            continue;
        }

        result[field] = [...(result[field] || []), check];
    }

    return result;
}

export function getArticleQualityField(checkId: string): ArticleQualityField | null {
    if (checkId.startsWith('required-section-') || checkId === 'code-language' || checkId === 'h1-limit') {
        return 'content';
    }

    const fieldByCheckId: Record<string, ArticleQualityField> = {
        'title-required': 'title',
        'date-valid': 'date',
        'published-description': 'description',
        'description-length': 'description',
        'tags-present': 'tags',
        'category-present': 'category',
        'sources-for-research': 'content',
        'source-url-valid': 'sourceLinks',
        'featured-public': 'featured',
        'evergreen-updated-date': 'updatedDate',
    };

    return fieldByCheckId[checkId] || null;
}

function normalizeHeadingText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, '');
}

function isValidDate(value: string): boolean {
    if (!value.trim()) {
        return false;
    }

    return !Number.isNaN(new Date(value).getTime());
}
