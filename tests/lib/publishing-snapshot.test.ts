import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { MediaRef, SiteSnapshot } from '@/lib/publishing/types';
import {
  computeCandidateDigest,
  computeSelectedRevision,
  createCandidate,
  validateArticlePaths,
} from '@/lib/publishing/snapshot';

function article(id: string, content: string, slug = id): Article {
  return {
    id,
    slug,
    title: id,
    content,
    date: '2026-09-30',
    description: '',
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    status: 'published',
  };
}

function snapshot(input: {
  articles?: Article[];
  navigation?: Category[];
  settings?: typeof DEFAULT_SITE_SETTINGS;
  media?: MediaRef[];
  redirects?: Array<{ from: string; to: string }>;
  removedPaths?: string[];
} = {}): SiteSnapshot {
  return {
    schemaVersion: 1,
    siteId: 'fixture-site',
    articles: input.articles ?? [],
    navigation: input.navigation ?? [],
    settings: input.settings ?? { ...DEFAULT_SITE_SETTINGS },
    media: input.media ?? [],
    redirects: input.redirects ?? [],
    removedPaths: input.removedPaths ?? [],
  };
}

function media(path: string, bytes: Uint8Array, mimeType = 'image/png'): MediaRef {
  return {
    originalPath: path,
    publicPath: `/media/${path}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    mimeType,
  };
}

function tool(title: string, url: string): Category {
  return {
    name: 'Resources',
    icon: 'R',
    slug: 'resources',
    tools: [{ icon: 'T', title, description: '', url, tags: ['ref'] }],
  };
}

function outputPath(articleOrSlug: Article | string): string {
  const slug = typeof articleOrSlug === 'string' ? articleOrSlug : articleOrSlug.slug ?? articleOrSlug.id;
  return `/posts/${encodeURIComponent(slug)}/`;
}

/**
 * One sealed release writes one file per public path: an article page, a rename redirect
 * or a removal notice. Publishing and withdrawing must never let two of them claim it.
 */
function expectDistinctOutputPaths(candidate: SiteSnapshot): void {
  const postPaths = new Set(candidate.articles.map(outputPath));
  const redirectSources = candidate.redirects.map((redirect) => redirect.from);

  for (const route of [...redirectSources, ...candidate.removedPaths]) {
    expect(postPaths.has(route), `${route} is claimed by both a live article and a stale record`).toBe(false);
  }
  for (const source of redirectSources) {
    expect(candidate.removedPaths, `${source} is claimed by both a redirect and a removal record`).not.toContain(source);
  }
  for (const redirect of candidate.redirects) {
    const target = new URL(redirect.to, 'https://guanlangzg.github.io').pathname;
    expect(
      postPaths.has(target) || redirectSources.includes(target),
      `${redirect.from} redirects to missing content: ${target}`,
    ).toBe(true);
  }
}

describe('explicit publication scope', () => {
  it('publishes A while keeping live B and never serializes B draft text', () => {
    const base = snapshot({ articles: [article('a', 'A old'), article('b', 'B live')] });
    const draft = snapshot({ articles: [article('a', 'A new'), article('b', 'SECRET B draft')] });
    const originalBase = structuredClone(base);

    const candidate = createCandidate(base, draft, {
      kind: 'article', articleId: 'a', action: 'publish',
    });

    expect(candidate.articles.find((item) => item.id === 'a')?.content).toBe('A new');
    expect(candidate.articles.find((item) => item.id === 'b')?.content).toBe('B live');
    expect(JSON.stringify(candidate)).not.toContain('SECRET B draft');
    expect(base).toEqual(originalBase);
    expect(candidate.articles[0]).not.toBe(base.articles[0]);
  });

  it('withdraws only the target article and preserves draft and history inputs', () => {
    const base = snapshot({ articles: [article('a', 'A live'), article('b', 'B live')] });
    const draft = snapshot({ articles: [article('a', 'A unpublished edits'), article('b', 'B draft')] });
    const draftBefore = structuredClone(draft);

    const candidate = createCandidate(base, draft, {
      kind: 'article', articleId: 'a', action: 'withdraw',
    });

    expect(candidate.articles.map((item) => item.id)).toEqual(['b']);
    expect(candidate.removedPaths).toContain('/posts/a/');
    expect(draft).toEqual(draftBefore);
  });

  it('removes a withdrawn path when publishing the article again', () => {
    const base = snapshot({ removedPaths: ['/posts/a/'] });
    const draft = snapshot({ articles: [article('a', 'republished')] });

    const candidate = createCandidate(base, draft, { kind: 'article', articleId: 'a', action: 'publish' });

    expect(candidate.removedPaths).not.toContain('/posts/a/');
    expectDistinctOutputPaths(candidate);
  });

  it('withdraws a renamed article without redirecting into the removed page', () => {
    const base = snapshot({ articles: [article('a', 'A live', 'old-slug')] });
    const renamed = createCandidate(base, snapshot({ articles: [article('a', 'A live', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });
    expectDistinctOutputPaths(renamed);

    const withdrawn = createCandidate(renamed, snapshot({ articles: [article('a', 'A live', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'withdraw',
    });

    expect(withdrawn.articles).toEqual([]);
    expect(withdrawn.removedPaths).toEqual(['/posts/new-slug/', '/posts/old-slug/']);
    expect(withdrawn.redirects).toEqual([]);
    expectDistinctOutputPaths(withdrawn);
  });

  it('lets a republished article take back its path before the next rename', () => {
    const base = snapshot({ articles: [article('a', 'A live', 'old-slug')] });
    const withdrawn = createCandidate(base, snapshot({ articles: [article('a', 'A live', 'old-slug')] }), {
      kind: 'article', articleId: 'a', action: 'withdraw',
    });
    const republished = createCandidate(withdrawn, snapshot({ articles: [article('a', 'A live', 'old-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });
    expect(republished.removedPaths).toEqual([]);
    expectDistinctOutputPaths(republished);

    const renamed = createCandidate(republished, snapshot({ articles: [article('a', 'A live', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });

    expect(renamed.redirects).toEqual([{ from: '/posts/old-slug/', to: '/posts/new-slug/' }]);
    expect(renamed.removedPaths).toEqual([]);
    expectDistinctOutputPaths(renamed);
  });

  it('drops the stale redirect when an article is republished at a redirect source', () => {
    const base = snapshot({ articles: [article('a', 'A live', 'old-slug')] });
    const renamed = createCandidate(base, snapshot({ articles: [article('a', 'A live', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });
    const withdrawn = createCandidate(renamed, snapshot({ articles: [article('a', 'A live', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'withdraw',
    });
    const republished = createCandidate(withdrawn, snapshot({ articles: [article('a', 'A live', 'old-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });

    expect(republished.articles.map((item) => item.slug)).toEqual(['old-slug']);
    expect(republished.redirects).toEqual([]);
    expect(republished.removedPaths).toEqual(['/posts/new-slug/']);
    expectDistinctOutputPaths(republished);
  });

  it('keeps publish, rename and withdraw sequences free of shared output paths', () => {
    const start = snapshot({ articles: [article('a', 'A live', 'x')] });
    const operations = [
      { kind: 'publish', slug: 'x' },
      { kind: 'publish', slug: 'y' },
      { kind: 'withdraw' },
    ] as const;

    function walk(state: SiteSnapshot, depth: number): void {
      if (depth === 0) return;
      const draftArticle = article('a', 'A live', state.articles.find((item) => item.id === 'a')?.slug ?? 'x');
      for (const operation of operations) {
        const next = operation.kind === 'withdraw'
          ? createCandidate(state, snapshot({ articles: [draftArticle] }), { kind: 'article', articleId: 'a', action: 'withdraw' })
          : createCandidate(state, snapshot({ articles: [article('a', 'A live', operation.slug)] }), { kind: 'article', articleId: 'a', action: 'publish' });
        expectDistinctOutputPaths(next);
        walk(next, depth - 1);
      }
    }

    expectDistinctOutputPaths(start);
    walk(start, 4);
  });

  it('replaces only navigation while retaining live articles and settings', () => {
    const base = snapshot({
      articles: [article('a', 'A live')],
      navigation: [tool('Old', 'https://old.example/')],
      settings: { ...DEFAULT_SITE_SETTINGS, siteDescription: 'live settings' },
    });
    const draft = snapshot({
      articles: [article('a', 'A draft')],
      navigation: [tool('New', 'https://new.example/')],
      settings: { ...DEFAULT_SITE_SETTINGS, siteDescription: 'draft settings' },
    });

    const candidate = createCandidate(base, draft, { kind: 'navigation' });

    expect(candidate.navigation[0].tools[0].title).toBe('New');
    expect(candidate.articles[0].content).toBe('A live');
    expect(candidate.settings.siteDescription).toBe('live settings');
  });

  it('replaces only settings while retaining live articles and navigation', () => {
    const base = snapshot({
      articles: [article('a', 'A live')],
      navigation: [tool('Live navigation', 'https://live.example/')],
    });
    const draft = snapshot({
      articles: [article('a', 'A draft')],
      navigation: [tool('Draft navigation', 'https://draft.example/')],
      settings: { ...DEFAULT_SITE_SETTINGS, siteDescription: 'draft settings' },
    });

    const candidate = createCandidate(base, draft, { kind: 'settings' });

    expect(candidate.settings.siteDescription).toBe('draft settings');
    expect(candidate.articles[0].content).toBe('A live');
    expect(candidate.navigation[0].tools[0].title).toBe('Live navigation');
  });

  it('bootstraps only the selected articles plus draft navigation and settings', () => {
    const base = snapshot();
    const draft = snapshot({
      articles: [article('a', 'selected'), article('b', 'SECRET unselected')],
      navigation: [tool('Bootstrap navigation', 'https://bootstrap.example/')],
      settings: { ...DEFAULT_SITE_SETTINGS, siteDescription: 'bootstrap settings' },
    });

    const candidate = createCandidate(base, draft, { kind: 'bootstrap', articleIds: ['a'] });

    expect(candidate.articles.map((item) => item.id)).toEqual(['a']);
    expect(candidate.navigation[0].tools[0].title).toBe('Bootstrap navigation');
    expect(candidate.settings.siteDescription).toBe('bootstrap settings');
    expect(JSON.stringify(candidate)).not.toContain('SECRET unselected');
  });

  it('keeps a Chinese single-segment slug unchanged', () => {
    const candidate = createCandidate(snapshot(), snapshot({ articles: [article('a', '文', '观澜-志')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });

    expect(candidate.articles[0].slug).toBe('观澜-志');
  });

  it.each(['a/b', 'a\\b', 'a%2fb', 'a%5Ctopic', 'a%252fother'])('rejects unsafe slug %s', (slug) => {
    expect(() => createCandidate(snapshot(), snapshot({ articles: [article('a', 'body', slug)] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    })).toThrow(/slug|path/i);
  });

  it('rejects reserved public route slugs', () => {
    expect(() => validateArticlePaths([article('a', 'body', 'api')])).toThrow(/reserved/i);
  });

  it('rejects duplicate article IDs and duplicate slugs', () => {
    expect(() => validateArticlePaths([article('a', 'one'), article('a', 'two', 'other')])).toThrow(/duplicate|重复/i);
    expect(() => validateArticlePaths([article('a', 'one', 'same'), article('b', 'two', 'same')])).toThrow(/duplicate|重复/i);
  });

  it('records redirects for a published slug change without dropping previous redirects', () => {
    const base = snapshot({
      articles: [article('a', 'old content', 'old-slug')],
      redirects: [{ from: '/posts/older/', to: '/posts/old-slug/' }],
    });
    const candidate = createCandidate(base, snapshot({ articles: [article('a', 'new content', 'new-slug')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    });

    expect(candidate.redirects).toEqual([
      { from: '/posts/older/', to: '/posts/old-slug/' },
      { from: '/posts/old-slug/', to: '/posts/new-slug/' },
    ]);
  });

  it('keeps only managed media referenced by the resulting live plus selected content', () => {
    const cBytes = new Uint8Array([4, 5, 6]);
    const unusedBytes = new Uint8Array([7, 8, 9]);
    const base = snapshot();
    const draft = snapshot({
      articles: [article('c', '![C](/media/files/c.png)')],
      media: [media('files/c.png', cBytes), media('files/unused.png', unusedBytes)],
    });

    const candidate = createCandidate(base, draft, { kind: 'bootstrap', articleIds: ['c'] });

    expect(candidate.media.map((item) => item.originalPath).sort()).toEqual(['files/c.png']);
  });

  it('keeps live B media and selected C media in a later article release', () => {
    const bBytes = new Uint8Array([1, 2, 3]);
    const cBytes = new Uint8Array([4, 5, 6]);
    const unusedBytes = new Uint8Array([7, 8, 9]);
    const base = snapshot({
      articles: [article('b', '![B](/media/files/b.png)')],
      media: [media('files/b.png', bBytes), media('files/unused.png', unusedBytes)],
    });
    const draft = snapshot({
      articles: [article('c', '![C](/media/files/c.png)')],
      media: [media('files/c.png', cBytes), media('files/unused.png', unusedBytes)],
    });

    const candidate = createCandidate(base, draft, { kind: 'article', articleId: 'c', action: 'publish' });

    expect(candidate.media.map((item) => item.originalPath).sort()).toEqual(['files/b.png', 'files/c.png']);
    expect(candidate.media).not.toContainEqual(media('files/unused.png', unusedBytes));
  });

  it('rejects references to missing managed media', () => {
    expect(() => createCandidate(snapshot(), snapshot({ articles: [article('a', '![](/media/files/missing.png)')] }), {
      kind: 'article', articleId: 'a', action: 'publish',
    })).toThrow(/missing|media/i);
  });
});

describe('canonical publishing digests', () => {
  it('ignores object key order and non-content release metadata', () => {
    const first = snapshot({ articles: [article('a', 'body')] });
    const reordered = JSON.parse(JSON.stringify(first, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse());
      }
      return value;
    })) as SiteSnapshot;

    expect(computeCandidateDigest(first)).toBe(computeCandidateDigest(reordered));
    expect(computeCandidateDigest({ ...first, generatedAt: 'later', retryCount: 8 } as SiteSnapshot))
      .toBe(computeCandidateDigest(first));
  });

  it('changes the candidate digest when managed media bytes change', () => {
    const originalBytes = new Uint8Array([1, 2, 3]);
    const changedBytes = new Uint8Array([1, 2, 4]);
    const original = snapshot({ media: [media('files/image.png', originalBytes)] });
    const changed = snapshot({ media: [media('files/image.png', changedBytes)] });

    expect(computeCandidateDigest(original)).not.toBe(computeCandidateDigest(changed));
  });

  it('computes selected revisions from scope, generation, selected inputs, and managed media', () => {
    const scope = { kind: 'article', articleId: 'a', action: 'publish' } as const;
    const selectedInputs = { id: 'a', content: 'body' };
    const asset = media('files/a.png', new Uint8Array([1]));

    expect(computeSelectedRevision({ scope, generation: 'generation-1', selectedInputs, media: [asset] }))
      .toBe(computeSelectedRevision({ scope, generation: 'generation-1', selectedInputs: { content: 'body', id: 'a' }, media: [asset] }));
    expect(computeSelectedRevision({ scope, generation: 'generation-1', selectedInputs, media: [asset] }))
      .not.toBe(computeSelectedRevision({ scope, generation: 'generation-2', selectedInputs, media: [asset] }));
  });
});
