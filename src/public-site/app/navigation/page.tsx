import snapshot from '@/public-site/snapshot';
import { PageHero } from '@/app/components/ui/PageHero';

export default function NavigationPage() {
    return <><PageHero eyebrow="NAVIGATION" title="导航目录" description="常用入口按冻结快照生成。" />{snapshot.navigation.map((group) => <section key={group.name} className="mt-8"><h2 className="text-xl font-semibold text-fg">{group.name}</h2><div className="mt-3 grid gap-3 md:grid-cols-2">{group.items.map((item) => <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer" className="rounded-token-card border border-border bg-surface-elevated p-4"><h3 className="font-semibold text-fg">{item.title}</h3><p className="mt-2 text-sm text-muted">{item.description}</p><p className="mt-2 font-mono text-xs text-subtle">{item.tags.join(' · ')}</p></a>)}</div></section>)}</>;
}
