import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getPostsAsync } from '@/lib/markdown';
import { FileText } from 'lucide-react';
import { PageHero } from '@/app/components/ui';
import { createCanonicalUrl, createOgImagePath } from '@/lib/site-url';
import { BlogArchiveClient } from './BlogArchiveClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const title = '文章归档';
    const description = '按时间收起这些工程笔记、项目复盘和资料整理。';
    const ogImage = createOgImagePath({ title, description });

    return {
        title,
        description,
        // ?kind= and ?category= filters produce crawlable duplicates of this page.
        alternates: {
            canonical: createCanonicalUrl('/blog'),
        },
        openGraph: {
            title,
            description,
            type: 'website',
            images: [ogImage],
        },
        twitter: {
            card: 'summary_large_image',
            title,
            description,
            images: [ogImage],
        },
    };
}

export default async function BlogPage() {
    const allArticlePosts = (await getPostsAsync()).filter((post) => !post.slugArray.includes('navigation'));
    const archiveYearCount = new Set(
        allArticlePosts.map((post) => post.date ? post.date.split('-')[0] : '未分类')
    ).size;

    return (
        <div className="space-y-token-section pb-10">
            <PageHero
                eyebrow={`${allArticlePosts.length} posts`}
                title="文章归档"
                description="按时间收起这些工程笔记、项目复盘和资料整理，方便回到某个阶段看当时为什么这么做。"
                aside={(
                    <div className="rounded-token-card border border-border bg-surface p-4">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-token-card border border-accent-200 bg-accent-50 text-accent">
                                <FileText className="h-5 w-5" />
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">archive.index</p>
                                <p className="text-sm font-medium text-fg">{archiveYearCount} 年归档</p>
                            </div>
                        </div>
                        <p className="mt-4 text-sm leading-relaxed text-muted">
                            文章按年份聚合，保留问题、背景和结论，适合回看一段时间里的技术选择。
                        </p>
                    </div>
                )}
            />

            <Suspense fallback={<div className="text-sm text-muted">加载归档...</div>}>
                <BlogArchiveClient posts={allArticlePosts} />
            </Suspense>
        </div>
    );
}
