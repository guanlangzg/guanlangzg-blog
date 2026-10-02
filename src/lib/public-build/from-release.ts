import type { Article } from '@/app/types/article';
import type { SiteSnapshot } from '@/lib/publishing/types';
import type { PublicManagedMedia, PublicSiteSnapshot } from '@/public-site/types';

export type PublicReleaseMedia = PublicManagedMedia;

export type PublicReleaseSnapshot = PublicSiteSnapshot & {
  media: PublicReleaseMedia[];
};

function articleSlug(article: Article): string {
  return article.slug ?? article.id;
}

function rewriteManagedMarkdown(content: string, media: PublicReleaseMedia[], releaseId: string): string {
  const mappings = media.map((item) => ({
    source: `/media/${item.source.replace(/^media[\\/]/, '')}`,
    target: `/_site/${releaseId}/${item.publicPath.replace(/^\//, '')}`,
  }));

  const fenced = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let cursor = 0;
  let output = '';
  for (const match of content.matchAll(fenced)) {
    const start = match.index ?? 0;
    output += replaceMarkdownImages(content.slice(cursor, start), mappings);
    output += match[0];
    cursor = start + match[0].length;
  }
  output += replaceMarkdownImages(content.slice(cursor), mappings);
  return output;
}

function replaceMarkdownImages(content: string, mappings: Array<{ source: string; target: string }>): string {
  return content.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (full, prefix: string, rawTarget: string, suffix: string) => {
    const parsed = /^([^?#]*)([?#].*)?$/.exec(rawTarget);
    if (!parsed) return full;
    const mapping = mappings.find((item) => item.source === parsed[1]);
    return mapping ? `${prefix}${mapping.target}${parsed[2] ?? ''}${suffix}` : full;
  });
}

function mapMedia(snapshot: SiteSnapshot): PublicReleaseMedia[] {
  return snapshot.media.map((item) => ({
    source: `media/${item.originalPath.replaceAll('\\', '/')}`,
    publicPath: `media/${item.originalPath.replaceAll('\\', '/')}`,
    sha256: item.sha256,
    size: item.size,
    mimeType: item.mimeType,
  }));
}

function mapManagedImage(article: Article): { source: string; alt: string } | undefined {
  const candidate = article as Article & { managedImage?: { source?: unknown; alt?: unknown } };
  if (!candidate.managedImage || typeof candidate.managedImage.source !== 'string' || typeof candidate.managedImage.alt !== 'string') {
    return undefined;
  }
  return { source: candidate.managedImage.source, alt: candidate.managedImage.alt };
}

export function fromReleaseSnapshot(releaseId: string, snapshot: SiteSnapshot): PublicReleaseSnapshot {
  const media = mapMedia(snapshot);
  const posts = snapshot.articles.map((article) => ({
    slug: articleSlug(article),
    title: article.title,
    description: article.description,
    date: article.date,
    tags: [...article.tags],
    content: rewriteManagedMarkdown(article.content, media, releaseId),
    ...(mapManagedImage(article) ? { managedImage: mapManagedImage(article) } : {}),
  }));

  return {
    releaseId,
    site: {
      title: snapshot.settings.siteName,
      description: snapshot.settings.siteDescription,
    },
    posts,
    navigation: snapshot.navigation.map((group) => ({
      name: group.name,
      items: group.tools.map((tool) => ({
        title: tool.title,
        description: tool.description,
        url: tool.url,
        tags: [...tool.tags],
      })),
    })),
    ...(snapshot.redirects.length ? { redirects: structuredClone(snapshot.redirects) } : {}),
    ...(snapshot.removedPaths.length ? { removedPaths: [...snapshot.removedPaths] } : {}),
    media,
  };
}
