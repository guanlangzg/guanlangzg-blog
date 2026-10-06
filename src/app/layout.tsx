import type { Metadata } from 'next';
import { JetBrains_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';
import { AppShell } from './components/layout';
import { readSiteSettingsFromDiskAsync } from '@/lib/editor-data-storage';
import { getPublicLiveSnapshot, isLiveReaderRuntime } from '@/lib/live-public-reader';
import { createOgImagePath, getSiteUrl } from '@/lib/site-url';
import { THEME_INIT_SCRIPT } from '@/lib/theme-init-script';

const jetbrains = JetBrains_Mono({
    subsets: ['latin'],
    variable: '--font-jetbrains-mono',
});

const ibmPlex = IBM_Plex_Sans({
    subsets: ['latin'],
    weight: ['300', '400', '500', '600', '700'],
    variable: '--font-ibm-plex',
});

export async function generateMetadata(): Promise<Metadata> {
    const settings = isLiveReaderRuntime() ? getPublicLiveSnapshot().settings : await readSiteSettingsFromDiskAsync();
    const ogImage = createOgImagePath({
        title: settings.siteName,
        description: settings.siteDescription,
    });

    return {
        metadataBase: getSiteUrl(),
        title: {
            template: `%s | ${settings.siteName}`,
            default: settings.siteName,
        },
        description: settings.siteDescription,
        alternates: {
            types: {
                'application/rss+xml': '/feed.xml',
            },
        },
        openGraph: {
            title: settings.siteName,
            description: settings.siteDescription,
            type: 'website',
            images: [ogImage],
        },
        twitter: {
            card: 'summary_large_image',
            title: settings.siteName,
            description: settings.siteDescription,
            images: [ogImage],
        },
    };
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="zh-CN" className={`${jetbrains.variable} ${ibmPlex.variable}`}>
            <body className="min-h-screen antialiased">
                {/* Applies the persisted theme before first paint; its sha256 is allowlisted in the middleware CSP. */}
                <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
                <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-link focus:text-white focus:rounded-lg focus:shadow-lg">
                    跳转到主内容
                </a>
                <AppShell>{children}</AppShell>
            </body>
        </html>
    );
}
