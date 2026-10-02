import { createHash } from 'node:crypto';
import type { Category } from '@/app/types/navigation';
import { stableJsonStringify } from '@/lib/stable-json';

export interface NavigationToolIdentity {
  id: string;
  normalizedUrl: string;
  groupOrder: number;
}

export interface NavigationCategoryIdentity {
  id: string;
  slug: string;
  tools: NavigationToolIdentity[];
}

export interface NavigationIdentityMap {
  schemaVersion: 1;
  categories: NavigationCategoryIdentity[];
}

export interface AmbiguousNavigationMatch {
  categorySlug: string;
  normalizedUrl: string;
  candidateIds: string[];
}

export interface ReconciledNavigationIdentityMap {
  identityMap: NavigationIdentityMap;
  ambiguousMatches: AmbiguousNavigationMatch[];
}

function stableId(prefix: string, identity: unknown): string {
  const digest = createHash('sha256')
    .update(stableJsonStringify(identity))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

export function normalizeNavigationUrl(value: string): string {
  const match = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)([\s\S]*)$/i.exec(value);
  if (!match) return value;

  const protocol = match[1].toLowerCase();
  const authority = match[2];
  const tail = match[3];
  const atIndex = authority.lastIndexOf('@');
  const userInfo = atIndex >= 0 ? authority.slice(0, atIndex + 1) : '';
  const hostAndPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  const hostMatch = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostAndPort);

  if (!hostMatch) return value;

  const host = hostMatch[1].toLowerCase();
  const port = hostMatch[2];
  const isDefaultPort = (protocol === 'https' && port === '443') || (protocol === 'http' && port === '80');
  const normalizedAuthority = `${userInfo}${host}${port && !isDefaultPort ? `:${port}` : ''}`;

  return `${protocol}://${normalizedAuthority}${tail}`;
}

function buildToolIdentities(category: Category): NavigationToolIdentity[] {
  return category.tools.map((tool, groupOrder) => {
    const normalizedUrl = normalizeNavigationUrl(tool.url);
    return {
      id: stableId('tool', { categorySlug: category.slug, normalizedUrl, groupOrder }),
      normalizedUrl,
      groupOrder,
    };
  });
}

export function createNavigationIdentityMap(categories: Category[]): NavigationIdentityMap {
  return {
    schemaVersion: 1,
    categories: categories.map((category) => ({
      id: stableId('category', { categorySlug: category.slug }),
      slug: category.slug,
      tools: buildToolIdentities(category),
    })),
  };
}

function createCategoryIdentity(category: Category, previous: NavigationCategoryIdentity | undefined): NavigationCategoryIdentity {
  return {
    id: previous?.id ?? stableId('category', { categorySlug: category.slug }),
    slug: category.slug,
    tools: [],
  };
}

function reconcileTools(
  category: Category,
  previous: NavigationCategoryIdentity | undefined,
  ambiguousMatches: AmbiguousNavigationMatch[],
): NavigationToolIdentity[] {
  const previousTools = previous?.tools ?? [];
  const usedIds = new Set<string>();

  return category.tools.map((tool, groupOrder) => {
    const normalizedUrl = normalizeNavigationUrl(tool.url);
    const candidates = previousTools.filter((item) => item.normalizedUrl === normalizedUrl);
    const reusable = candidates.filter((item) => !usedIds.has(item.id));
    let id: string;

    if (reusable.length === 1 && candidates.length === 1) {
      id = reusable[0].id;
      usedIds.add(id);
    } else {
      id = stableId('tool', { categorySlug: category.slug, normalizedUrl, groupOrder });
      if (candidates.length > 1) {
        ambiguousMatches.push({
          categorySlug: category.slug,
          normalizedUrl,
          candidateIds: candidates.map((item) => item.id),
        });
      }
    }

    return { id, normalizedUrl, groupOrder };
  });
}

export function reconcileNavigationIdentityMap(
  categories: Category[],
  previous: NavigationIdentityMap,
): ReconciledNavigationIdentityMap {
  const ambiguousMatches: AmbiguousNavigationMatch[] = [];
  const identityCategories = categories.map((category) => {
    const previousCategory = previous.categories.find((item) => item.slug === category.slug);
    const identity = createCategoryIdentity(category, previousCategory);
    identity.tools = reconcileTools(category, previousCategory, ambiguousMatches);
    return identity;
  });

  return {
    identityMap: { schemaVersion: 1, categories: identityCategories },
    ambiguousMatches,
  };
}
