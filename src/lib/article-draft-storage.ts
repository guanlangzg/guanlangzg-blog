import type { Frontmatter } from '@/app/types/article';

export const ARTICLE_DRAFT_VERSION = 1;
export const ARTICLE_DRAFT_KEY_PREFIX = 'blog-editor-article-draft:v2';

export interface StoredDraft {
  version: number;
  updatedAt: number;
  content: string;
  frontmatter: Frontmatter;
}

function isFrontmatter(value: unknown): value is Frontmatter {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<Frontmatter>;

  return (
    typeof candidate.title === 'string' &&
    typeof candidate.date === 'string' &&
    typeof candidate.description === 'string' &&
    Array.isArray(candidate.tags) &&
    candidate.tags.every((tag) => typeof tag === 'string')
  );
}

export function getArticleDraftKey(articleKey: string): string {
  return `${ARTICLE_DRAFT_KEY_PREFIX}:${articleKey}`;
}

export function readStoredDraft(key: string): StoredDraft | null {
  try {
    const rawDraft = window.localStorage.getItem(key);

    if (!rawDraft) {
      return null;
    }

    const draft = JSON.parse(rawDraft) as Partial<StoredDraft>;

    if (
      draft.version !== ARTICLE_DRAFT_VERSION ||
      typeof draft.updatedAt !== 'number' ||
      typeof draft.content !== 'string' ||
      !isFrontmatter(draft.frontmatter)
    ) {
      return null;
    }

    return draft as StoredDraft;
  } catch (error) {
    console.error('Failed to read article draft:', error);
    return null;
  }
}

export function writeStoredDraft(key: string, frontmatter: Frontmatter, content: string): number | null {
  try {
    const updatedAt = Date.now();

    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: ARTICLE_DRAFT_VERSION,
        updatedAt,
        frontmatter,
        content,
      })
    );

    return updatedAt;
  } catch (error) {
    console.error('Failed to write article draft:', error);
    return null;
  }
}

export function clearStoredDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to clear article draft:', error);
  }
}
