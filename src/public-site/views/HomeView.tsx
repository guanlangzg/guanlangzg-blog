import Image from 'next/image';
import { PageHero } from '@/app/components/ui/PageHero';
import { PostCard } from '@/app/components/ui/PostCard';
import snapshot from '@/public-site/snapshot';
import { getStaticAssetUrl } from '@/public-site/paths';

export function HomeView() {
    const latestPosts = snapshot.posts.slice(0, 4);
    const highlights = snapshot.navigation.flatMap((group) => group.items.map((item) => ({ ...item, category: group.name })).slice(0, 5));

    return (
        <div className="space-y-10 pb-12 md:space-y-14">
            <section className="border-b border-border pb-10 md:pb-12">
                <p className="mb-5 inline-flex items-center gap-2 rounded-token-badge border border-border-soft bg-surface px-3 py-1.5 font-mono text-xs uppercase tracking-token-caps text-accent">
                    <Image src={getStaticAssetUrl(snapshot.releaseId, 'guanlan-logo.png')} alt="" width={20} height={20} className="h-5 w-5 rounded-sm" priority unoptimized />
                    观澜志 · 静态公开站
                </p>
                <h1 className="max-w-4xl font-serif text-4xl font-medium leading-tight tracking-token-normal text-fg md:text-5xl">{snapshot.site.title}</h1>
                <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted md:text-lg">{snapshot.site.description}</p>
                <div className="mt-7 flex flex-wrap gap-3">
                    <a className="rounded-token-button bg-fg px-4 py-3 text-sm font-medium text-surface" href="/blog/">阅读文章</a>
                    <a className="rounded-token-button border border-border bg-surface px-4 py-3 text-sm font-medium text-muted" href="/navigation/">打开导航</a>
                </div>
            </section>
            <section>
                <PageHero title="最近整理的笔记" description="仅包含本次冻结候选快照中的公开文章。" />
                <div className="mt-5 space-y-3">
                    {latestPosts.map((post) => <PostCard key={post.slug} title={post.title} description={post.description} date={post.date} href={`/posts/${encodeURIComponent(post.slug)}/`} />)}
                </div>
            </section>
            <section>
                <PageHero title="长期会用的入口" description="从同一份候选快照导出导航和静态搜索字段。" />
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                    {highlights.map((item) => <a key={`${item.category}-${item.title}`} href={item.url} target="_blank" rel="noopener noreferrer" className="rounded-token-card border border-border bg-surface-elevated p-4"><span className="font-mono text-xs text-subtle">{item.category}</span><h3 className="mt-2 font-semibold text-fg">{item.title}</h3><p className="mt-1 text-sm text-muted">{item.description}</p></a>)}
                </div>
            </section>
        </div>
    );
}
