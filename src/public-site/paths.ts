export const STATIC_SITE_ROOT = '/_site';

export function getStaticAssetUrl(releaseId: string, relativePath: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(releaseId)) {
        throw new Error('Invalid releaseId');
    }
    const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new Error('Invalid static asset path');
    }
    return `${STATIC_SITE_ROOT}/${releaseId}/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`;
}
