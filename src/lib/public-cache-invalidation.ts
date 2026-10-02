import { revalidatePath } from 'next/cache';

const PUBLIC_CONTENT_PATHS: Array<{ path: string; type?: 'layout' | 'page' }> = [
    { path: '/', type: 'layout' },
    { path: '/', type: 'page' },
    { path: '/blog', type: 'page' },
    { path: '/navigation', type: 'page' },
    { path: '/posts/[...slug]', type: 'page' },
    { path: '/sitemap.xml' },
];

export function invalidatePublicContentCache(reason: string): void {
    for (const entry of PUBLIC_CONTENT_PATHS) {
        try {
            revalidatePath(entry.path, entry.type);
        } catch (error) {
            console.warn(`[public-cache-invalidation] Failed to revalidate ${entry.path} after ${reason}:`, error);
        }
    }
}
