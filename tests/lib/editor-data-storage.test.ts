import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArticleSlug } from '@/lib/article-data';
import {
    EditorDataFileInvalidError,
    ManifestTransactionIncompleteError,
    getDefaultNavigationSeedFilePath,
    getEditorDataRoot,
    getEditorDataResourceManifest,
    readArticlesFromDisk,
    readArticlesFromDiskAsync,
    readEditorDataManifest,
    readNavigationFromDisk,
    readNavigationFromDiskAsync,
    readSiteSettingsFromDiskAsync,
    readSiteSettingsFromDisk,
    restoreEditorDataRootAtomically,
    withEditorDataRootLock,
    writeArticlesToDisk,
    writeArticlesToDiskIfRevisionMatches,
    EditorDataRestoreIncompleteError,
} from '@/lib/editor-data-storage';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { getSearchIndexFilePath } from '@/lib/search-index';
import { getEditorAuditLogFilePath } from '@/lib/editor-audit-log';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { Article } from '@/app/types/article';

const ORIGINAL_BLOG_DATA_ROOT = process.env.BLOG_DATA_ROOT;
const ORIGINAL_CWD = process.cwd();
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-storage-'));
    tempDirectories.push(tempRoot);
    process.env.BLOG_DATA_ROOT = tempRoot;
    return tempRoot;
}

function writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

function createArticle(id: string, title: string): Article {
    const article = {
        id,
        title,
        date: '2026-05-24',
        description: `${title} description`,
        tags: ['test'],
        content: `# ${title}`,
        createdAt: 1,
        updatedAt: 2,
    };

    return {
        ...article,
        slug: createArticleSlug(article),
        kind: 'essay',
        status: 'published',
        featured: false,
        sourceLinks: [],
        revisionNotes: [],
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    if (ORIGINAL_BLOG_DATA_ROOT === undefined) {
        delete process.env.BLOG_DATA_ROOT;
    } else {
        process.env.BLOG_DATA_ROOT = ORIGINAL_BLOG_DATA_ROOT;
    }

    process.chdir(ORIGINAL_CWD);

    while (tempDirectories.length > 0) {
        fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
    }
});

describe('editor data storage configuration', () => {
    it('uses project data as the default runtime directory when BLOG_DATA_ROOT is missing', () => {
        delete process.env.BLOG_DATA_ROOT;
        const tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-default-root-'));
        tempDirectories.push(tempProjectRoot);
        process.chdir(tempProjectRoot);

        expect(getEditorDataRoot()).toBe(path.join(tempProjectRoot, 'data'));
        expect(getRuntimeDataRootPath()).toBe(path.join(tempProjectRoot, 'data'));
    });

    it('keeps committed navigation seed data under content/seeds', () => {
        expect(getDefaultNavigationSeedFilePath()).toContain('content');
        expect(getDefaultNavigationSeedFilePath()).toContain('seeds');
        expect(getDefaultNavigationSeedFilePath()).toContain('navigation');
    });

    it('writes to the default runtime directory when BLOG_DATA_ROOT is missing', async () => {
        delete process.env.BLOG_DATA_ROOT;
        const tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-default-write-'));
        tempDirectories.push(tempProjectRoot);
        process.chdir(tempProjectRoot);

        await writeArticlesToDisk([]);

        expect(fs.existsSync(path.join(tempProjectRoot, 'data', 'articles', 'articles.json'))).toBe(true);
    });

    it('falls back to default site settings when runtime settings are missing', () => {
        delete process.env.BLOG_DATA_ROOT;

        expect(readSiteSettingsFromDisk()).toEqual(DEFAULT_SITE_SETTINGS);
    });

    it('creates and updates a manifest when runtime data is written', async () => {
        createTempDataRoot();
        const fsyncSpy = vi.spyOn(fs, 'fsyncSync');

        const firstManifest = await writeArticlesToDisk([]);
        const manifestAfterWrite = readEditorDataManifest();
        const secondManifest = await writeArticlesToDisk([]);

        expect(firstManifest.revision).toBe(manifestAfterWrite.resources.articles?.revision);
        expect(secondManifest.revision).not.toBe(firstManifest.revision);
        expect(fsyncSpy).toHaveBeenCalled();
    });

    it('writes audit events and a derived search index when articles are committed', async () => {
        createTempDataRoot();
        const articles = [createArticle('article-indexed', 'Indexed Article')];

        const manifest = await writeArticlesToDisk(articles);
        const auditEvents = fs.readFileSync(getEditorAuditLogFilePath(), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { action: string; resource: string; metadata: Record<string, unknown> });
        const searchIndex = JSON.parse(fs.readFileSync(getSearchIndexFilePath(), 'utf8')) as {
            documents: Array<{ type: string; title: string; content?: string }>;
        };

        expect(auditEvents).toContainEqual(
            expect.objectContaining({
                action: 'data.write',
                resource: 'articles',
                metadata: expect.objectContaining({
                    revision: manifest.revision,
                }),
            })
        );
        expect(searchIndex.documents).toContainEqual(
            expect.objectContaining({
                type: 'post',
                title: 'Indexed Article',
                content: '# Indexed Article',
            })
        );
    });

    it('writes articles only when the current revision still matches', async () => {
        createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        const nextArticles = [createArticle('article-2', 'Next Article')];
        const originalManifest = await writeArticlesToDisk(originalArticles);

        const result = await writeArticlesToDiskIfRevisionMatches(nextArticles, originalManifest.revision);

        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                resourceManifest: expect.objectContaining({
                    revision: expect.any(String),
                }),
            })
        );
        expect(readArticlesFromDisk()).toEqual(nextArticles);
    });

    it('returns the current articles without writing when the expected revision is stale', async () => {
        createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        const newerArticles = [createArticle('article-2', 'Newer Article')];
        const attemptedArticles = [createArticle('article-3', 'Attempted Article')];
        const originalManifest = await writeArticlesToDisk(originalArticles);
        const newerManifest = await writeArticlesToDisk(newerArticles);

        const result = await writeArticlesToDiskIfRevisionMatches(attemptedArticles, originalManifest.revision);

        expect(result).toEqual({
            success: false,
            currentValue: newerArticles,
            currentManifest: expect.objectContaining({
                revision: newerManifest.revision,
            }),
        });
        expect(readArticlesFromDisk()).toEqual(newerArticles);
    });

    it('derives a stable revision for existing data without writing a manifest during reads', () => {
        const tempRoot = createTempDataRoot();
        const articles: unknown[] = [];

        writeText(path.join(tempRoot, 'articles', 'articles.json'), JSON.stringify(articles));

        const manifest = getEditorDataResourceManifest('articles', articles);

        expect(manifest?.revision).toMatch(/^derived-/);
        expect(fs.existsSync(path.join(tempRoot, 'manifest.json'))).toBe(false);
    });

    it('uses stable hashes for semantically equal object key orders', async () => {
        createTempDataRoot();
        const articles = [createArticle('article-1', 'Original Article')];
        const reorderedArticles = [
            {
                revisionNotes: [],
                sourceLinks: [],
                featured: false,
                status: 'published',
                kind: 'essay',
                slug: articles[0].slug,
                updatedAt: 2,
                createdAt: 1,
                content: '# Original Article',
                tags: ['test'],
                description: 'Original Article description',
                date: '2026-05-24',
                title: 'Original Article',
                id: 'article-1',
            },
        ];

        await writeArticlesToDisk(articles);

        const manifest = getEditorDataResourceManifest('articles', reorderedArticles);

        expect(manifest?.revision).not.toMatch(/^derived-/);
    });

    it('does not update manifest when a resource transaction write fails before replacement', async () => {
        const tempRoot = createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        const nextArticles = [createArticle('article-2', 'Next Article')];
        const originalManifest = await writeArticlesToDisk(originalArticles);
        const renameSync = fs.renameSync;

        vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
            if (String(newPath) === path.join(tempRoot, 'articles', 'articles.json')) {
                throw new Error('Simulated resource replacement failure.');
            }

            return renameSync(oldPath, newPath);
        });

        await expect(writeArticlesToDisk(nextArticles)).rejects.toThrow('Simulated resource replacement failure.');

        expect(readArticlesFromDisk()).toEqual(originalArticles);
        expect(readEditorDataManifest().resources.articles?.revision).toBe(originalManifest.revision);
        expect(fs.existsSync(path.join(tempRoot, '.manifest-transaction.json'))).toBe(false);
    });

    it('leaves and recovers a manifest transaction marker when manifest replacement fails', async () => {
        const tempRoot = createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        const nextArticles = [createArticle('article-2', 'Next Article')];
        const originalManifest = await writeArticlesToDisk(originalArticles);
        const renameSync = fs.renameSync;
        let manifestFailureInjected = false;

        vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
            if (!manifestFailureInjected && String(newPath) === path.join(tempRoot, 'manifest.json')) {
                manifestFailureInjected = true;
                throw new Error('Simulated manifest replacement failure.');
            }

            return renameSync(oldPath, newPath);
        });

        await expect(writeArticlesToDisk(nextArticles)).rejects.toThrow('Simulated manifest replacement failure.');

        expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'articles', 'articles.json'), 'utf8'))).toEqual(nextArticles);
        expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'manifest.json'), 'utf8')).resources.articles.revision).toBe(originalManifest.revision);
        expect(fs.existsSync(path.join(tempRoot, '.manifest-transaction.json'))).toBe(true);
        expect(() => readArticlesFromDisk()).toThrow(ManifestTransactionIncompleteError);

        vi.mocked(fs.renameSync).mockRestore();

        expect(await readArticlesFromDiskAsync()).toEqual(nextArticles);
        expect(readEditorDataManifest().resources.articles?.revision).not.toBe(originalManifest.revision);
        expect(fs.existsSync(path.join(tempRoot, '.manifest-transaction.json'))).toBe(false);
    });

    it('rejects corrupt runtime article JSON instead of returning empty data', () => {
        const tempRoot = createTempDataRoot();
        const articlesPath = path.join(tempRoot, 'articles', 'articles.json');

        writeText(articlesPath, '{');

        expect(() => readArticlesFromDisk()).toThrow(EditorDataFileInvalidError);
        expect(fs.readFileSync(articlesPath, 'utf8')).toBe('{');
    });

    it('rejects invalid runtime settings instead of falling back to defaults', () => {
        const tempRoot = createTempDataRoot();

        writeText(path.join(tempRoot, 'settings', 'site.json'), JSON.stringify({ siteName: '' }));

        expect(() => readSiteSettingsFromDisk()).toThrow(EditorDataFileInvalidError);
    });

    it('does not write navigation seed data back during reads', () => {
        const tempRoot = createTempDataRoot();
        const navigationPath = path.join(tempRoot, 'navigation', 'tools.json');

        expect(readNavigationFromDisk().length).toBeGreaterThan(0);
        expect(fs.existsSync(navigationPath)).toBe(false);
    });

    it('reads runtime data through asynchronous public read helpers', async () => {
        const tempRoot = createTempDataRoot();
        const article = createArticle('article-async', 'Async Article');
        const navigation = [{
            name: 'Docs',
            icon: 'book',
            slug: 'docs',
            tools: [{
                icon: 'link',
                title: 'Example Docs',
                description: 'Reference documentation',
                url: 'https://example.com/docs',
                tags: ['docs'],
            }],
        }];

        writeText(path.join(tempRoot, 'articles', 'articles.json'), JSON.stringify([article]));
        writeText(path.join(tempRoot, 'navigation', 'tools.json'), JSON.stringify(navigation));

        expect(await readArticlesFromDiskAsync()).toEqual([article]);
        expect(await readNavigationFromDiskAsync()).toEqual(navigation);
        expect(await readSiteSettingsFromDiskAsync()).toEqual(DEFAULT_SITE_SETTINGS);
    });

    it('keeps the data write lock fresh while a long operation holds it', async () => {
        const tempRoot = createTempDataRoot();
        vi.useFakeTimers();

        await withEditorDataRootLock(async () => {
            const lockHeartbeatPath = path.join(tempRoot, '.data-write.lock', 'heartbeat.json');
            const firstHeartbeat = fs.readFileSync(lockHeartbeatPath, 'utf8');

            await vi.advanceTimersByTimeAsync(31_000);

            expect(fs.readFileSync(lockHeartbeatPath, 'utf8')).not.toBe(firstHeartbeat);
        });

        expect(fs.existsSync(path.join(tempRoot, '.data-write.lock'))).toBe(false);
    });

    it('throws on sync reads when an incomplete restore is pending outside a lock', async () => {
        const tempRoot = createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        await writeArticlesToDisk(originalArticles);
        const backupRoot = path.join(tempRoot, '.restore-backup-test');

        fs.mkdirSync(path.join(backupRoot, 'articles'), { recursive: true });
        fs.copyFileSync(
            path.join(tempRoot, 'articles', 'articles.json'),
            path.join(backupRoot, 'articles', 'articles.json')
        );
        fs.copyFileSync(
            path.join(tempRoot, 'manifest.json'),
            path.join(backupRoot, 'manifest.json')
        );
        writeText(
            path.join(tempRoot, '.restore-state.json'),
            JSON.stringify({
                version: 1,
                phase: 'replacing',
                stagingDirectory: path.join(tempRoot, '.restore-staging-test'),
                backupDirectory: backupRoot,
                files: [
                    path.join(tempRoot, 'articles', 'articles.json'),
                    path.join(tempRoot, 'navigation', 'tools.json'),
                    path.join(tempRoot, 'settings', 'site.json'),
                    path.join(tempRoot, 'manifest.json'),
                ],
                updatedAt: new Date().toISOString(),
            })
        );
        writeText(
            path.join(tempRoot, 'articles', 'articles.json'),
            JSON.stringify([createArticle('article-2', 'Mixed Article')])
        );

        expect(() => readArticlesFromDisk()).toThrow(EditorDataRestoreIncompleteError);
    });

    it('recovers incomplete restores during async reads', async () => {
        const tempRoot = createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];
        const originalManifest = await writeArticlesToDisk(originalArticles);
        const backupRoot = path.join(tempRoot, '.restore-backup-test');

        fs.mkdirSync(path.join(backupRoot, 'articles'), { recursive: true });
        fs.copyFileSync(
            path.join(tempRoot, 'articles', 'articles.json'),
            path.join(backupRoot, 'articles', 'articles.json')
        );
        fs.copyFileSync(
            path.join(tempRoot, 'manifest.json'),
            path.join(backupRoot, 'manifest.json')
        );
        writeText(
            path.join(tempRoot, '.restore-state.json'),
            JSON.stringify({
                version: 1,
                phase: 'replacing',
                stagingDirectory: path.join(tempRoot, '.restore-staging-test'),
                backupDirectory: backupRoot,
                files: [
                    path.join(tempRoot, 'articles', 'articles.json'),
                    path.join(tempRoot, 'navigation', 'tools.json'),
                    path.join(tempRoot, 'settings', 'site.json'),
                    path.join(tempRoot, 'manifest.json'),
                ],
                updatedAt: new Date().toISOString(),
            })
        );
        writeText(
            path.join(tempRoot, 'articles', 'articles.json'),
            JSON.stringify([createArticle('article-2', 'Mixed Article')])
        );

        expect(await readArticlesFromDiskAsync()).toEqual(originalArticles);
        expect(readEditorDataManifest().resources.articles?.revision).toBe(originalManifest.revision);
        expect(fs.existsSync(path.join(tempRoot, '.restore-state.json'))).toBe(false);
    });

    it('leaves a restore marker when rollback cannot be completed', async () => {
        const tempRoot = createTempDataRoot();
        const originalArticles = [createArticle('article-1', 'Original Article')];

        await writeArticlesToDisk(originalArticles);

        const renameSync = fs.renameSync;
        const copyFileSync = fs.copyFileSync;
        let stagedReplaceCount = 0;

        vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
            const oldPathText = String(oldPath);

            if (oldPathText.includes('.restore-staging') && !oldPathText.endsWith('.tmp')) {
                stagedReplaceCount += 1;
            }

            if (stagedReplaceCount === 2) {
                throw new Error('Simulated replacement failure.');
            }

            return renameSync(oldPath, newPath);
        });
        vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination) => {
            if (String(destination) === path.join(tempRoot, 'articles', 'articles.json')) {
                throw new Error('Simulated rollback failure.');
            }

            return copyFileSync(source, destination);
        });

        await expect(
            restoreEditorDataRootAtomically({
                articles: [createArticle('article-2', 'Replacement Article')],
                navigation: [],
                settings: DEFAULT_SITE_SETTINGS,
            })
        ).rejects.toThrow('Simulated rollback failure.');

        expect(fs.existsSync(path.join(tempRoot, '.restore-state.json'))).toBe(true);
        expect(() => readArticlesFromDisk()).toThrow(EditorDataRestoreIncompleteError);
    });

    it('fsyncs restore backup files before replacing live data', async () => {
        createTempDataRoot();
        await writeArticlesToDisk([createArticle('article-1', 'Original Article')]);
        const openedPaths: string[] = [];
        const openSync = fs.openSync;

        vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, mode) => {
            openedPaths.push(String(filePath));
            return openSync(filePath, flags, mode);
        });

        await restoreEditorDataRootAtomically({
            articles: [createArticle('article-2', 'Replacement Article')],
            navigation: [],
            settings: DEFAULT_SITE_SETTINGS,
        });

        expect(openedPaths.some((filePath) =>
            filePath.includes('.restore-backup') && filePath.endsWith(path.join('articles', 'articles.json'))
        )).toBe(true);
    });
});
