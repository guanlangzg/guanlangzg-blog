import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import { fromReleaseSnapshot } from '@/lib/public-build/from-release';
import type { SiteSnapshot } from '@/lib/publishing/types';

const imageBytes = new Uint8Array([1, 2, 3]);
const imageHash = createHash('sha256').update(imageBytes).digest('hex');

function snapshot(): SiteSnapshot {
  return {
    schemaVersion: 1,
    siteId: 'site-1',
    articles: [{
      id: 'article-1',
      slug: 'article-one',
      title: 'Article One',
      date: '',
      description: '',
      tags: ['guide'],
      content: [
        '![Cover](/media/files/cover.png?width=2#top)',
        '',
        '```md',
        '![Do not rewrite](/media/files/cover.png)',
        '```',
        '',
        '[asset](/media/files/cover.png)',
      ].join('\n'),
      createdAt: 1,
      updatedAt: 2,
      status: 'draft',
    }],
    navigation: [{
      name: 'Tools',
      icon: 'tool',
      slug: 'tools',
      tools: [{ icon: 'link', title: 'Tool', description: 'Description', url: 'https://example.com', tags: ['web'] }],
    }],
    settings: { ...DEFAULT_SITE_SETTINGS, siteName: 'Frozen Site', siteDescription: 'Frozen Description' },
    media: [{
      originalPath: 'files/cover.png',
      publicPath: '/media/files/cover.png',
      sha256: imageHash,
      size: imageBytes.byteLength,
      mimeType: 'image/png',
    }],
    redirects: [],
    removedPaths: [],
  };
}

describe('public snapshot projection', () => {
  it('projects only frozen site data and preserves optional empty metadata', () => {
    const projected = fromReleaseSnapshot('release-1', snapshot());

    expect(projected.site).toEqual({ title: 'Frozen Site', description: 'Frozen Description' });
    expect(projected.posts[0]).toMatchObject({ slug: 'article-one', title: 'Article One', date: '', description: '' });
    expect(projected.navigation[0].items[0]).toMatchObject({ title: 'Tool', url: 'https://example.com' });
    expect(projected.media).toEqual([expect.objectContaining({ source: 'media/files/cover.png', sha256: imageHash })]);
  });

  it('rewrites managed Markdown images and links outside fenced code only', () => {
    const content = fromReleaseSnapshot('release-1', snapshot()).posts[0].content;

    expect(content).toContain('](/_site/release-1/media/files/cover.png?width=2#top)');
    expect(content).toContain('[asset](/_site/release-1/media/files/cover.png)');
    expect(content).toContain('![Do not rewrite](/media/files/cover.png)');
  });

  it('rewrites the equivalent spellings of a managed media reference outside fenced code', () => {
    const base = snapshot();
    base.articles[0].content = [
      '![relative](./media/files/cover.png)',
      '![bare](media/files/cover.png)',
      '![origin](https://guanlangzg.github.io/media/files/cover.png)',
      '![external](https://cdn.example.com/media/files/cover.png)',
      '![unmanaged](./media/files/other.png)',
    ].join('\n');

    const content = fromReleaseSnapshot('release-1', base).posts[0].content;

    expect(content).toContain('![relative](/_site/release-1/media/files/cover.png)');
    expect(content).toContain('![bare](/_site/release-1/media/files/cover.png)');
    expect(content).toContain('![origin](/_site/release-1/media/files/cover.png)');
    expect(content).toContain('![external](https://cdn.example.com/media/files/cover.png)');
    expect(content).toContain('![unmanaged](./media/files/other.png)');
  });

  it('does not read or include fields from the mutable working copy', () => {
    const base = snapshot();
    const projected = fromReleaseSnapshot('release-1', base);

    base.articles[0].content = 'changed after projection';
    base.navigation[0].tools[0].title = 'changed after projection';

    expect(projected.posts[0].content).toContain('![Do not rewrite](/media/files/cover.png)');
    expect(projected.navigation[0].items[0].title).toBe('Tool');
  });
});
