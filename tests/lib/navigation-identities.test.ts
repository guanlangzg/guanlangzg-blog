import { describe, expect, it } from 'vitest';
import type { Category } from '@/app/types/navigation';
import {
  createNavigationIdentityMap,
  normalizeNavigationUrl,
  reconcileNavigationIdentityMap,
} from '@/lib/navigation-identities';

function category(tools: Array<{ title: string; url: string }>): Category[] {
  return [{
    name: 'Resources',
    icon: 'R',
    slug: 'resources',
    tools: tools.map((tool) => ({
      icon: 'T',
      title: tool.title,
      description: `${tool.title} description`,
      url: tool.url,
      tags: ['reference'],
    })),
  }];
}

describe('navigation identity sidecar', () => {
  it('generates deterministic IDs from category slug, normalized URL, and group order', () => {
    const first = createNavigationIdentityMap(category([
      { title: 'One', url: 'https://EXAMPLE.com:443/one/?q=1#top' },
      { title: 'Two', url: 'https://example.com/two/' },
    ]));
    const repeated = createNavigationIdentityMap(category([
      { title: 'One', url: 'https://example.com/one/?q=1#top' },
      { title: 'Two', url: 'https://example.com/two/' },
    ]));

    expect(first).toEqual(repeated);
    expect(first.categories[0].tools).toHaveLength(2);
    expect(first.categories[0].tools[0].id).not.toBe(first.categories[0].tools[1].id);
    expect(first.categories[0].tools[0].groupOrder).toBe(0);
    expect(first.categories[0].tools[1].groupOrder).toBe(1);
  });

  it('persists existing IDs across edits and reordering instead of deriving IDs again', () => {
    const initial = category([
      { title: 'One', url: 'https://example.com/one/' },
      { title: 'Two', url: 'https://example.com/two/' },
    ]);
    const saved = JSON.parse(JSON.stringify(createNavigationIdentityMap(initial))) as ReturnType<typeof createNavigationIdentityMap>;
    const oneId = saved.categories[0].tools[0].id;
    const twoId = saved.categories[0].tools[1].id;
    const edited = category([
      { title: 'Two renamed', url: 'https://EXAMPLE.com:443/two/' },
      { title: 'One renamed', url: 'https://example.com/one/' },
    ]);

    const result = reconcileNavigationIdentityMap(edited, saved);

    expect(result.ambiguousMatches).toEqual([]);
    expect(result.identityMap.categories[0].tools.map((item) => item.id)).toEqual([twoId, oneId]);
    expect(result.identityMap.categories[0].tools.map((item) => item.groupOrder)).toEqual([0, 1]);
  });

  it('normalizes only protocol, host case, and default ports', () => {
    expect(normalizeNavigationUrl('HTTPS://EXAMPLE.COM:443/a/?q=1#section'))
      .toBe('https://example.com/a/?q=1#section');
    expect(normalizeNavigationUrl('http://Example.com:80/a/'))
      .toBe('http://example.com/a/');
    expect(normalizeNavigationUrl('https://example.com/a')).not.toBe(normalizeNavigationUrl('https://example.com/a/'));
    expect(normalizeNavigationUrl('https://example.com/a?q=1')).not.toBe(normalizeNavigationUrl('https://example.com/a?q=2'));
    expect(normalizeNavigationUrl('https://example.com/a#one')).not.toBe(normalizeNavigationUrl('https://example.com/a#two'));
  });

  it('surfaces ambiguous legacy URL matches instead of silently matching one ID', () => {
    const prior = createNavigationIdentityMap(category([
      { title: 'Duplicate one', url: 'https://example.com/shared/' },
      { title: 'Duplicate two', url: 'https://EXAMPLE.com:443/shared/' },
    ]));
    const result = reconcileNavigationIdentityMap(category([
      { title: 'Legacy entry', url: 'https://example.com/shared/' },
    ]), prior);

    expect(result.ambiguousMatches).toHaveLength(1);
    expect(result.ambiguousMatches[0].categorySlug).toBe('resources');
    expect(result.ambiguousMatches[0].normalizedUrl).toBe('https://example.com/shared/');
    expect(result.ambiguousMatches[0].candidateIds).toHaveLength(2);
  });
});
