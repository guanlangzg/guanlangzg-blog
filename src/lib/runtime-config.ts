import path from 'node:path';

const DEFAULT_DATA_ROOT_DIRECTORY_NAME = 'data';
const DOCKER_DATA_ROOT = '/var/lib/blog-navigation';

export type RuntimeConfigSource = 'env' | 'default';

export interface RuntimeDataRoot {
    path: string;
    source: RuntimeConfigSource;
}

function normalizeConfiguredPath(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? path.resolve(trimmed) : null;
}

export function getRuntimeDataRoot(): RuntimeDataRoot {
    const configured = normalizeConfiguredPath(process.env.BLOG_DATA_ROOT);

    if (configured) {
        return {
            path: configured,
            source: 'env',
        };
    }

    return {
        path: process.env.BLOG_NAVIGATION_DOCKER === 'true'
            ? DOCKER_DATA_ROOT
            : path.join(process.cwd(), DEFAULT_DATA_ROOT_DIRECTORY_NAME),
        source: 'default',
    };
}

export function getRuntimeDataRootPath(): string {
    return getRuntimeDataRoot().path;
}

export function getRuntimeSettingsFilePath(fileName: string): string {
    return path.join(getRuntimeDataRootPath(), 'settings', fileName);
}
