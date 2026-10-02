import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';
import type { RestorableEditorData } from '@/lib/restoring/plan';
import { createRestorePlan } from '@/lib/restoring/plan';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@/lib/site-settings';

const CURRENT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const BACKUP_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);

function mediaAsset(bytes: Uint8Array, filePath = 'files/2026/06/shared.png') {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    id: hash,
    path: filePath,
    publicPath: `/media/${filePath}`,
    mimeType: 'image/png' as const,
    size: bytes.byteLength,
    hash,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

function article(id: string, slug: string, content: string): Article {
  return {
    id,
    slug,
    title: id,
    date: '2026-06-01',
    description: '',
    tags: [],
    content,
    createdAt: 1,
    updatedAt: 2,
    kind: 'essay',
    status: 'published',
    featured: false,
    sourceLinks: [],
    revisionNotes: [],
  };
}

function category(tools: Category['tools']): Category[] {
  return [{ name: 'Resources', icon: 'R', slug: 'resources', tools }];
}

function tool(title: string, url: string): Category['tools'][number] {
  return { icon: 'T', title, description: title, url, tags: ['reference'] };
}

function data(input: Omit<Partial<RestorableEditorData>, 'settings'> & { settings?: Partial<SiteSettings> } = {}): RestorableEditorData {
  const navigation = input.navigation ?? [];
  return {
    articles: input.articles ?? [],
    navigation,
    settings: { ...DEFAULT_SITE_SETTINGS, ...input.settings },
    navigationIdentities: input.navigationIdentities ?? null,
    media: input.media ?? { manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [] }, files: [] },
  };
}

describe('restore merge planning', () => {
  it('detects article ID and slug conflicts, legacy navigation ambiguity, settings fields, and media bytes', () => {
    const currentNav = category([
      tool('First copy', 'https://example.com/shared/'),
      tool('Second copy', 'https://EXAMPLE.com:443/shared/'),
    ]);
    const backupNav = category([tool('Legacy copy', 'https://example.com/shared/')]);
    const currentMedia = mediaAsset(CURRENT_BYTES);
    const backupMedia = mediaAsset(BACKUP_BYTES);
    const current = data({
      articles: [article('same-id', 'same-id', 'current'), article('slug-owner', 'taken', 'owner')],
      navigation: currentNav,
      navigationIdentities: createNavigationIdentityMap(currentNav),
      settings: { ...DEFAULT_SITE_SETTINGS, siteName: 'Current site' },
      media: {
        manifest: { version: 1, updatedAt: '2026-06-01T00:00:00.000Z', assets: [currentMedia] },
        files: [{ path: currentMedia.path, bytes: CURRENT_BYTES }],
      },
    });
    const backup = data({
      articles: [article('same-id', 'same-id', 'backup'), article('new-id', 'taken', 'new')],
      navigation: backupNav,
      navigationIdentities: null,
      settings: { ...DEFAULT_SITE_SETTINGS, siteName: 'Backup site' },
      media: {
        manifest: { version: 1, updatedAt: '2026-06-02T00:00:00.000Z', assets: [backupMedia] },
        files: [{ path: backupMedia.path, bytes: BACKUP_BYTES }],
      },
    });

    const plan = createRestorePlan(current, backup, {
      currentRevision: 'revision-1',
      backupCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    const kinds = new Set(plan.conflicts.map((conflict) => conflict.kind));

    expect(kinds).toEqual(new Set([
      'article-id',
      'article-slug',
      'navigation-ambiguous',
      'settings-field',
      'media-path',
    ]));
    expect(plan.conflicts.every((conflict) => conflict.conflictId && conflict.summary)).toBe(true);
    expect(plan.conflicts.find((conflict) => conflict.kind === 'settings-field')?.resolutions)
      .not.toContain('keep-both');
    expect(plan.binding).toEqual(expect.objectContaining({
      currentRevision: 'revision-1',
      backupCommit: '0123456789abcdef0123456789abcdef01234567',
      backupContentDigest: expect.any(String),
    }));
  });

  it('returns a frozen deterministic plan with added and identical inventory', () => {
    const currentArticle = article('existing', 'existing', 'same');
    const current = data({ articles: [currentArticle] });
    const backup = data({ articles: [currentArticle, article('new', 'new', 'new content')] });
    const binding = { currentRevision: 'r1', backupCommit: 'a'.repeat(40) };

    const first = createRestorePlan(current, backup, binding);
    const second = createRestorePlan(current, backup, binding);

    expect(first).toEqual(second);
    expect(first.added.articles.map((item) => item.itemId)).toEqual(['new']);
    expect(first.identical.articles.map((item) => item.itemId)).toEqual(['existing']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.conflicts)).toBe(true);
  });
});
