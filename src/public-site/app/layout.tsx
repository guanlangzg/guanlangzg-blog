import type { Metadata } from 'next';
import './globals.css';
import { SiteHeader } from '@/public-site/components/SiteHeader';
import snapshot from '@/public-site/snapshot';
import { getStaticAssetUrl } from '@/public-site/paths';
import { ThemeInitScript } from '@/public-site/components/ThemeInitScript';

export const metadata: Metadata = {
    title: { default: snapshot.site.title, template: `%s | ${snapshot.site.title}` },
    description: snapshot.site.description,
    metadataBase: new URL('https://guanlangzg.github.io'),
    openGraph: { siteName: snapshot.site.title, type: 'website', locale: 'zh_CN' },
    icons: { icon: getStaticAssetUrl(snapshot.releaseId, 'favicon-32.png') },
};

export default function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="zh-CN">
            <body className="min-h-screen antialiased">
                <ThemeInitScript />
                {/* Sealed adapter: enables version-bound preview navigation only when the
                    document URL carries this artifact's own previewRelease value. */}
                <script src={getStaticAssetUrl(snapshot.releaseId, 'preview.js')} defer data-preview-adapter={snapshot.releaseId} />
                <a className="sr-only focus:not-sr-only" href="#main-content">跳转到主内容</a>
                <SiteHeader />
                <main id="main-content" className="mx-auto min-h-[calc(100vh-4rem)] max-w-token-wide px-4 py-6 sm:px-6 md:py-8">{children}</main>
                <footer className="mx-auto max-w-token-wide px-4 py-8 text-center text-sm text-muted sm:px-6">观澜志 · 静态公开站</footer>
            </body>
        </html>
    );
}
