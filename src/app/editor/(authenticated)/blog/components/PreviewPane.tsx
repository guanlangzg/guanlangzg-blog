'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, Clock3, Eye, History, LinkIcon, Tag } from 'lucide-react';
import { MarkdownContent } from '@/app/components/markdown';
import type { Frontmatter } from '@/app/types/article';
import { getArticleKindLabel, getArticleStatusLabel } from '@/lib/article-metadata';
import { getMarkdownHeadings } from '@/lib/article-quality';
import { normalizeRevisionNotes, normalizeSourceLinks } from '@/lib/source-links';

interface PreviewPaneProps {
  content: string;
  frontmatter?: Frontmatter;
  readingMinutes?: number;
}

export function PreviewPane({ content, frontmatter, readingMinutes }: PreviewPaneProps) {
  const [isClient, setIsClient] = useState(false);
  const sourceLinks = normalizeSourceLinks(frontmatter?.sourceLinks);
  const revisionNotes = normalizeRevisionNotes(frontmatter?.revisionNotes);
  const headings = getMarkdownHeadings(content).filter((heading) => heading.level >= 2);

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (!isClient) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-3/4 rounded bg-surface"></div>
          <div className="h-4 w-full rounded bg-surface"></div>
          <div className="h-4 w-5/6 rounded bg-surface"></div>
          <div className="h-4 w-4/6 rounded bg-surface"></div>
        </div>
      </div>
    );
  }

  return (
    <div data-preview-pane className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-11 items-center justify-between border-b border-border bg-background/80 px-4">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <Eye className="h-4 w-4 text-subtle" />
          预览
        </div>
        <span className="font-mono text-xs text-subtle">rendered markdown</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {content.trim() ? (
          <div className="min-h-full p-6">
            {frontmatter ? (
              <header className="mb-6 border-b border-border pb-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                  <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                    {getArticleKindLabel(frontmatter.kind)}
                  </span>
                  <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                    {getArticleStatusLabel(frontmatter.status)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {frontmatter.date || 'UNTRACKED'}
                  </span>
                  {frontmatter.updatedDate ? (
                    <span>修订 {frontmatter.updatedDate}</span>
                  ) : null}
                  {readingMinutes ? (
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3.5 w-3.5" />
                      {readingMinutes} 分钟
                    </span>
                  ) : null}
                </div>
                {frontmatter.title ? (
                  <h1 className="mt-3 text-2xl font-semibold text-fg">{frontmatter.title}</h1>
                ) : null}
                {frontmatter.description ? (
                  <p className="mt-2 text-sm leading-6 text-muted">{frontmatter.description}</p>
                ) : null}
                {frontmatter.category || frontmatter.series || frontmatter.tags.length ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {frontmatter.category ? (
                      <span className="rounded-token-badge bg-accent-50 px-2 py-1 text-accent">
                        {frontmatter.category}
                      </span>
                    ) : null}
                    {frontmatter.series ? (
                      <span className="rounded-token-badge border border-border bg-surface px-2 py-1">
                        {frontmatter.series}
                      </span>
                    ) : null}
                    {frontmatter.tags.length ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <Tag className="h-3.5 w-3.5 shrink-0 text-subtle" />
                        <span className="truncate">{frontmatter.tags.join(', ')}</span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </header>
            ) : null}
            {headings.length >= 4 ? (
              <nav className="mb-5 rounded-token-card border border-border bg-surface p-4 text-sm shadow-token-card">
                <h2 className="font-medium text-fg">目录</h2>
                <div className="mt-3 grid gap-1">
                  {headings.slice(0, 12).map((heading) => (
                    <a
                      key={`${heading.index}-${heading.text}`}
                      href={`#${heading.id}`}
                      className="flex min-h-[44px] items-center truncate rounded-token-sm px-3 py-2 text-muted hover:bg-accent-50 hover:text-accent"
                    >
                      {heading.text}
                    </a>
                  ))}
                </div>
              </nav>
            ) : null}
            <MarkdownContent
              content={content}
              className="mt-5 rounded-token-card border border-border bg-surface p-4 md:p-6"
              skipDuplicateTitle={frontmatter?.title}
            />
            {sourceLinks.length ? (
              <section className="mt-6 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-4 w-4 text-subtle" />
                  <h2 className="font-semibold text-fg">参考资料</h2>
                </div>
                <ul className="mt-3 space-y-2 text-sm">
                  {sourceLinks.map((source) => (
                    <li key={`${source.title}-${source.url}`}>
                      <a
                        href={source.url}
                        className="font-medium text-accent hover:text-accent-800"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.title || source.url}
                      </a>
                      {source.note ? <p className="mt-1 text-muted">{source.note}</p> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {revisionNotes.length ? (
              <section className="mt-6 rounded-token-card border border-border bg-surface p-4 shadow-token-card">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-subtle" />
                  <h2 className="font-semibold text-fg">修订记录</h2>
                </div>
                <ul className="mt-3 space-y-2 text-sm text-muted">
                  {revisionNotes.map((revision) => (
                    <li key={`${revision.date}-${revision.note}`}>
                      <span className="font-mono text-xs text-subtle">{revision.date}</span>
                      <span className="ml-2">{revision.note}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-subtle">
            预览会在这里显示
          </div>
        )}
      </div>
    </div>
  );
}
