import { randomUUID } from 'node:crypto';
import type { EditorMediaMimeType } from '@/lib/editor-media-storage';
import type { R2BackupConfig } from '@/lib/r2-backup-storage';

function joinR2Key(...parts: string[]): string {
    return parts
        .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
}

function encodeKeySegment(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

function getMediaExtension(mimeType: EditorMediaMimeType): string {
    switch (mimeType) {
        case 'image/jpeg':
            return 'jpg';
        case 'image/png':
            return 'png';
        case 'image/webp':
            return 'webp';
        case 'image/gif':
            return 'gif';
    }
}

export function createR2ChunkedSnapshotId(now = new Date()): string {
    const timestamp = now.toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');

    return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function resolveR2ChunkedKey(config: R2BackupConfig, relativeKey: string): string {
    return joinR2Key(config.prefix, relativeKey);
}

export function createR2ChunkedRepositoryKey(): string {
    return 'v2/repo.json';
}

export function createR2ChunkedLatestPointerKey(): string {
    return 'v2/latest.json';
}

export function createR2ChunkedSnapshotRootKey(snapshotId: string, now = new Date()): string {
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');

    return joinR2Key('v2', 'snapshots', year, month, day, snapshotId);
}

export function createR2ChunkedSnapshotManifestKey(snapshotRootKey: string): string {
    return joinR2Key(snapshotRootKey, 'manifest.json');
}

export function createR2ChunkedArticleIndexKey(snapshotRootKey: string, page: number): string {
    return joinR2Key(snapshotRootKey, `articles-${String(page).padStart(4, '0')}.json`);
}

export function createR2ChunkedMediaIndexKey(snapshotRootKey: string, page: number): string {
    return joinR2Key(snapshotRootKey, `media-${String(page).padStart(4, '0')}.json`);
}

export function createR2ChunkedArticleObjectKey(articleId: string, articleHash: string): string {
    return joinR2Key('v2', 'objects', 'articles', encodeKeySegment(articleId), `${articleHash}.json`);
}

export function createR2ChunkedNavigationObjectKey(hash: string): string {
    return joinR2Key('v2', 'objects', 'navigation', `${hash}.json`);
}

export function createR2ChunkedSettingsObjectKey(hash: string): string {
    return joinR2Key('v2', 'objects', 'settings', `${hash}.json`);
}

export function createR2ChunkedMediaManifestObjectKey(hash: string): string {
    return joinR2Key('v2', 'objects', 'media-manifests', `${hash}.json`);
}

export function createR2ChunkedMediaObjectKey(hash: string, mimeType: EditorMediaMimeType): string {
    return joinR2Key('v2', 'media', hash.slice(0, 2), `${hash}.${getMediaExtension(mimeType)}`);
}
