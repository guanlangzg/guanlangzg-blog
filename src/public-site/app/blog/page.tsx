import snapshot from '@/public-site/snapshot';
import { PageHero } from '@/app/components/ui/PageHero';
import { PostCard } from '@/app/components/ui/PostCard';

export default function BlogPage() {
    return <><PageHero eyebrow="BLOG ARCHIVE" title="文章归档" description="来自冻结的公开候选快照。" /><div className="mt-6 space-y-3">{snapshot.posts.map((post) => <PostCard key={post.slug} title={post.title} description={post.description} date={post.date} href={`/posts/${encodeURIComponent(post.slug)}/`} />)}</div></>;
}
