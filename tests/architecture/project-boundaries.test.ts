import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getPostsAsync } from '@/lib/markdown';
import {
    readArticlesFromDiskAsync,
    readNavigationFromDiskAsync,
    readSiteSettingsFromDiskAsync,
} from '@/lib/editor-data-storage';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

const temporaryRoots: string[] = [];

function createTemporaryDataRoot(): string {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlangzg-blog-boundaries-'));
    temporaryRoots.push(dataRoot);
    return dataRoot;
}

afterAll(() => {
    for (const dataRoot of temporaryRoots) {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

describe('project boundaries', () => {
    it('reads seed content and the existing runtime schema without .env or real data', async () => {
        delete process.env.BLOG_DATA_ROOT;
        const isolatedRoot = createTemporaryDataRoot();
        process.env.BLOG_DATA_ROOT = isolatedRoot;

        const [posts, articles, navigation, settings] = await Promise.all([
            getPostsAsync(),
            readArticlesFromDiskAsync(),
            readNavigationFromDiskAsync(),
            readSiteSettingsFromDiskAsync(),
        ]);

        expect(posts.some((post) => post.slug === '2026-05-25-getting-started')).toBe(true);
        expect(articles).toEqual([]);
        expect(navigation.length).toBeGreaterThan(0);
        expect(settings).toEqual(DEFAULT_SITE_SETTINGS);
        expect(settings.siteName).toBe('观澜志');
        expect(fs.readdirSync(isolatedRoot)).toEqual([]);
        for (const runtimeFile of [
            'data/articles/articles.json',
            'data/navigation/tools.json',
            'data/settings/site.json',
            'data/settings/cloudflare-r2.json',
        ]) {
            expect(fs.existsSync(path.join(process.cwd(), runtimeFile)), runtimeFile).toBe(false);
        }
        expect(fs.readdirSync(process.cwd()).some((name) => name.startsWith('.env'))).toBe(false);
    });

    it('keeps the current Guanlan identity assets with their approved hashes', () => {
        const expectedHashes: Record<string, string> = {
            'guanlan-logo.png': '05ef4a04bd36e19c0da71c2a912b7c8234e7a1ffe76c35824ea64b0605585416',
            'favicon-16.png': 'da4e34173cce9a744fc2634489d23922c70214cbbfb2bf066fe3b51d50328fe6',
            'favicon-32.png': '1e560a32212731de1a8ae42c22eb2a4598307dc9832ba4f0ea1e25981fbd1bde',
            'favicon-48.png': 'bcf36543e84ca10a329e277094d6c333e40653a8131e005ccb0a0d9d65fb51b8',
            'favicon-64.png': 'e52e63680c58af1a0f961ee3c0baf3d671037ee8565980d99468dfaeb930dd34',
        };

        for (const [fileName, expectedHash] of Object.entries(expectedHashes)) {
            const bytes = fs.readFileSync(path.join(process.cwd(), 'public', fileName));
            expect(bytes.length).toBeGreaterThan(0);
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
        }
    });

    it('does not track local runtime data, credentials, or agent artifacts', () => {
        const gitIgnore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');

        for (const pattern of ['.env*', '/data/', 'output/', '.next/', '.tmp/', '.zcode/', '.codex/', '.zread/', '.playwright-mcp/']) {
            expect(gitIgnore).toContain(pattern);
        }
    });
});
