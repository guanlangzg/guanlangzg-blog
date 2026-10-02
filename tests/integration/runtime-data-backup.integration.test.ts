import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getArticles } from '@/app/api/data/articles/route';
import { GET as getBackup } from '@/app/api/data/backup/route';
import { getEditorDataResourceManifest } from '@/lib/editor-data-storage';
import { createDefaultSiteSettings } from '@/lib/site-settings';
import {
    cleanupTempDirectories,
    createAuthedEditorRequest,
    createTempDirectory,
    restoreEnv,
} from '../helpers/api-route';

vi.mock('@/lib/editor-remote-backup', () => ({
    getRemoteBackupQueueSnapshot: () => ({ pending: 0, failed: 0 }),
    queueCurrentBackupToRemote: vi.fn(),
    shouldQueueRemoteBackupRetry: () => false,
    syncCurrentBackupToRemote: vi.fn().mockResolvedValue({ enabled: false, skipped: true }),
}));

vi.mock('@/lib/public-cache-invalidation', () => ({
    invalidatePublicContentCache: vi.fn(),
}));

const originalEnv = {
    BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
    EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
    TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
};
const tempRoots: string[] = [];

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedRuntimeRoot(root: string): void {
    writeJson(path.join(root, 'articles', 'articles.json'), [{
        id: 'integration-article',
        title: 'Integration Article',
        date: '2026-05-24',
        description: 'Integration description',
        tags: ['integration'],
        content: '# Integration Article',
        createdAt: 1,
        updatedAt: 2,
        slug: 'integration-article',
        kind: 'essay',
        status: 'published',
        featured: false,
        sourceLinks: [],
        revisionNotes: [],
    }]);
    writeJson(path.join(root, 'navigation', 'tools.json'), []);
    writeJson(path.join(root, 'settings', 'site.json'), createDefaultSiteSettings());
}

afterEach(() => {
    restoreEnv(originalEnv);
    cleanupTempDirectories(tempRoots);
});

describe('runtime data integration boundary', () => {
    it('reads a real JSON data root and builds a backup payload from the same files', async () => {
        const root = createTempDirectory('blog-navigation-integration-');
        tempRoots.push(root);
        seedRuntimeRoot(root);
        process.env.BLOG_DATA_ROOT = root;
        process.env.EDITOR_ACCESS_TOKEN = 'integration-editor-token';
        process.env.TRUSTED_PROXY_IPS = '*';

        const articlesResponse = await getArticles(
            await createAuthedEditorRequest('http://localhost/api/data/articles')
        );
        const articlesPayload = await articlesResponse.json();
        const backupResponse = await getBackup(
            await createAuthedEditorRequest('http://localhost/api/data/backup')
        );
        const backupPayload = await backupResponse.json();

        expect(articlesResponse.status).toBe(200);
        expect(articlesPayload.articles).toHaveLength(1);
        expect(backupResponse.status).toBe(200);
        expect(backupPayload.data.articles).toHaveLength(1);
        expect(backupPayload.data.articles[0].id).toBe('integration-article');
        expect(backupPayload.data.navigation).toEqual([]);
        expect(backupPayload.data.settings.siteName).toBe(createDefaultSiteSettings().siteName);
        expect(getEditorDataResourceManifest('articles', articlesPayload.articles)?.revision)
            .toBe(articlesPayload.revision);
    });

    it('returns an unauthenticated response through the real route boundary', async () => {
        const root = createTempDirectory('blog-navigation-integration-auth-');
        tempRoots.push(root);
        seedRuntimeRoot(root);
        process.env.BLOG_DATA_ROOT = root;
        process.env.EDITOR_ACCESS_TOKEN = 'integration-editor-token';

        const response = await getArticles(new NextRequest('http://localhost/api/data/articles'));

        expect(response.status).toBe(401);
    });
});
