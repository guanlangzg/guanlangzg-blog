import type { Metadata } from 'next';
import { readNavigationFromDiskAsync } from '@/lib/editor-data-storage';
import { NavigationDirectory } from './NavigationDirectory';
import { createCanonicalUrl, createOgImagePath } from '@/lib/site-url';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const title = '常用链接导航';
    const description = '开发文档、写作资料和高频工具入口集中检索。';
    const ogImage = createOgImagePath({ title, description });

    return {
        title,
        description,
        alternates: {
            canonical: createCanonicalUrl('/navigation'),
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

async function getNavigationData() {
    return readNavigationFromDiskAsync();
}

export default async function NavigationPage() {
    const navData = await getNavigationData();
    const linkCount = navData.reduce((total, category) => total + category.tools.length, 0);

    return (
        <div className="space-y-3 pb-8">
            <header className="grid gap-3 border-b border-border pb-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="min-w-0">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-token-caps text-accent">
                        <span>directory.index</span>
                        <span className="rounded-token-badge border border-border-soft bg-bg px-2 py-0.5 text-subtle">
                            {navData.length} groups / {linkCount} links
                        </span>
                    </div>
                    <h1 className="text-2xl font-semibold leading-tight tracking-token-normal text-fg md:text-3xl">
                        常用链接导航
                    </h1>
                    <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">
                        开发文档、写作资料和高频工具入口集中检索；优先看结果，再按分类收窄。
                    </p>
                </div>

                <dl className="grid grid-cols-3 overflow-hidden rounded-token-card border border-border-soft bg-bg text-sm md:w-[320px]">
                    <div className="border-r border-border-soft px-3 py-2">
                        <dt className="font-mono text-[0.68rem] uppercase tracking-token-caps text-subtle">mode</dt>
                        <dd className="mt-1 truncate font-semibold text-fg">search</dd>
                    </div>
                    <div className="border-r border-border-soft px-3 py-2">
                        <dt className="font-mono text-[0.68rem] uppercase tracking-token-caps text-subtle">scope</dt>
                        <dd className="mt-1 font-semibold text-fg">{navData.length}</dd>
                    </div>
                    <div className="px-3 py-2">
                        <dt className="font-mono text-[0.68rem] uppercase tracking-token-caps text-subtle">links</dt>
                        <dd className="mt-1 font-semibold text-fg">{linkCount}</dd>
                    </div>
                </dl>
            </header>

            <NavigationDirectory categories={navData} totalLinkCount={linkCount} />
        </div>
    );
}
