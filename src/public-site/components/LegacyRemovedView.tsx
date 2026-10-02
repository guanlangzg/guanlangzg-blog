/* eslint-disable @next/next/no-html-link-for-pages -- Legacy paths must navigate through a fresh static document. */
import { PageHero } from '@/app/components/ui/PageHero';

export function LegacyRemovedView() {
    return (
        <section className="mx-auto max-w-3xl py-10">
            <PageHero eyebrow="CONTENT REMOVED" title="内容已移除" description="该旧文章路径不再提供内容。你可以返回首页，或搜索当前已发布的文章与导航。" />
            <nav aria-label="页面导航" className="mt-6 flex flex-wrap gap-3">
                <a href="/" className="rounded-token-button bg-fg px-4 py-3 text-sm font-medium text-surface">返回首页</a>
                <a href="/search/" className="rounded-token-button border border-border bg-surface px-4 py-3 text-sm font-medium text-fg">搜索内容</a>
            </nav>
        </section>
    );
}
