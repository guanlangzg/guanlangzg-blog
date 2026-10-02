export const EDITOR_SESSION_COOKIE = 'editor_session';
export const EDITOR_CSRF_COOKIE = 'editor_csrf';
export const EDITOR_CSRF_HEADER = 'x-editor-csrf-token';
export const EDITOR_SESSION_MAX_AGE = 60 * 60 * 8;
export const SESSION_NAMESPACE = 'blog-navigation-editor-session:v1';

export function getEditorAccessToken(): string | null {
    const token = process.env.EDITOR_ACCESS_TOKEN?.trim();
    return token ? token : null;
}

export function getSafeEditorNextPath(rawPath?: string | null): string {
    if (!rawPath) {
        return '/editor';
    }

    try {
        if (rawPath.startsWith('//')) {
            return '/editor';
        }

        const normalized = new URL(rawPath, 'http://localhost');

        if (normalized.host !== 'localhost') {
            return '/editor';
        }

        if (!normalized.pathname.startsWith('/editor')) {
            return '/editor';
        }

        return `${normalized.pathname}${normalized.search}`;
    } catch {
        return '/editor';
    }
}
