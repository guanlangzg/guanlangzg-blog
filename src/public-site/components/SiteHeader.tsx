/* eslint-disable @next/next/no-html-link-for-pages -- Preview navigation must request a fresh, authenticated document. */
import Image from 'next/image';
import { ThemeToggle } from '@/app/components/theme/ThemeToggle';
import { getStaticAssetUrl } from '@/public-site/paths';
import snapshot from '@/public-site/snapshot';

export function SiteHeader() {
    const logoPath = getStaticAssetUrl(snapshot.releaseId, 'guanlan-logo.png');
    return (
        <header className="sticky top-0 z-50 border-b border-border bg-[var(--header-bg)] backdrop-blur-xl">
            <div className="mx-auto flex min-h-14 max-w-token-wide items-center justify-between gap-3 px-4 sm:px-6">
                <a className="flex min-h-11 items-center gap-2 rounded-token-button border border-border bg-surface px-3 text-sm font-medium text-fg" href="/">
                    <Image src={logoPath} alt="" width={24} height={24} className="h-6 w-6 rounded-sm" priority unoptimized />
                    <span>观澜志</span>
                </a>
                <nav className="flex items-center gap-2" aria-label="主导航">
                    <a className="rounded-token-button border border-border bg-surface px-3 py-2 text-sm text-muted" href="/blog/">博客</a>
                    <a className="rounded-token-button border border-border bg-surface px-3 py-2 text-sm text-muted" href="/navigation/">导航</a>
                    <a className="rounded-token-button border border-border bg-surface px-3 py-2 text-sm text-muted" href="/search/">搜索</a>
                </nav>
                <ThemeToggle compact />
            </div>
        </header>
    );
}
