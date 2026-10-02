import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

vi.mock('@/lib/markdown', () => ({
  getPostsAsync: async () => [
    {
      title: 'Latest Note',
      description: 'Latest description',
      date: '2026-05-25',
      slug: 'latest-note',
      slugArray: ['latest-note'],
    },
  ],
}));

vi.mock('@/lib/editor-data-storage', () => ({
  readNavigationFromDiskAsync: async () => [],
  readSiteSettingsFromDiskAsync: async () => ({
    ...DEFAULT_SITE_SETTINGS,
    introCardEyebrow: 'editable intro',
    introCardTitle: 'Editable desk title',
    introCardDescription: 'Editable desk description',
    introCardMetaOneLabel: 'Focus',
    introCardMetaOneValue: 'Editable focus value',
    introCardMetaTwoLabel: 'Rule',
    introCardMetaTwoValue: 'Editable rule value',
    introCardMetaThreeLabel: 'Reader',
    introCardMetaThreeValue: 'Editable reader value',
    introCardStartLabel: 'begin here',
  }),
}));

vi.mock('next/image', () => ({
  default: ({ alt = '' }: { alt?: string; src: string; width: number; height: number; className?: string; priority?: boolean }) => (
    <span aria-label={alt} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('Home page', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders homepage intro card text from site settings', async () => {
    const html = renderToStaticMarkup(await Home());

    expect(html).toContain('editable intro');
    expect(html).toContain('Editable desk title');
    expect(html).toContain('Editable desk description');
    expect(html).toContain('Editable focus value');
    expect(html).toContain('begin here');
    expect(html).toContain('(1)');
    expect(html).not.toContain('我会优先写这些');
    expect(html).not.toContain('你好，这里是我的公开工作日志');
  });
});
