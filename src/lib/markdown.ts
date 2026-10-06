import fs from 'fs';
import fsPromises from 'node:fs/promises';
import path from 'path';
import {
    getArticlesDataFilePath,
    getEditorDataRoot,
    readArticlesFromDisk,
    readArticlesFromDiskAsync,
    readEditorDataManifest,
    readEditorDataManifestAsync,
} from '@/lib/editor-data-storage';
import type { Article, ArticleKind, ArticleRevisionNote, ArticleSourceLink, ArticleStatus } from '@/app/types/article';
import { createArticleSlug } from '@/lib/article-data';
import { isPublicArticleStatus, normalizeArticleKind, normalizeArticleStatus } from '@/lib/article-metadata';
import { countMarkdownWords } from '@/lib/article-quality';
import { normalizeOptionalString } from '@/lib/utils';
import { registerEditorRuntimeCacheReset } from '@/lib/editor-runtime-cache';
import { normalizeSourceLinks, normalizeRevisionNotes } from '@/lib/source-links';
import { getPublicLiveSnapshot, isLiveReaderRuntime, type PublicLiveSnapshot } from '@/lib/live-public-reader';
import { parseRawMarkdownFrontmatter } from '@/lib/frontmatter';
import { parseArticleIndex, type ArticleIndexEntry } from '@/lib/article-index';

export interface PostMeta {
    slug: string;
    slugArray: string[];
    title: string;
    date: string;
    description?: string;
    updatedDate?: string;
    tags: string[];
    kind: ArticleKind;
    status: ArticleStatus;
    category?: string;
    series?: string;
    featured: boolean;
    readingMinutes: number;
    sourceLinks: ArticleSourceLink[];
    revisionNotes: ArticleRevisionNote[];
}

export interface SearchablePost {
    meta: PostMeta;
    content: string;
}

const contentDir = path.join(process.cwd(), 'content', 'seeds', 'posts');

function isRuntimeArticleSourceEnabled(): boolean {
    return Boolean(getEditorDataRoot());
}

function isRuntimeArticleDataAvailable(): boolean {
    const articlesPath = getArticlesDataFilePath();
    return Boolean(articlesPath && fs.existsSync(articlesPath));
}

async function isRuntimeArticleDataAvailableAsync(): Promise<boolean> {
    const articlesPath = getArticlesDataFilePath();

    if (!articlesPath) {
        return false;
    }

    try {
        await fsPromises.access(articlesPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }

        throw error;
    }
}

function normalizeDate(value: unknown): string {
    if (!value) {
        return '';
    }

    const date = new Date(String(value));

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toISOString().split('T')[0];
}

function createRuntimeSlug(article: Article): string {
    return article.slug || createArticleSlug(article);
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function mapArticleToPostMeta(article: Article): PostMeta {
    const slug = createRuntimeSlug(article);

    return {
        slug,
        slugArray: [slug],
        title: article.title || 'Untitled',
        date: normalizeDate(article.date),
        description: article.description || '',
        updatedDate: normalizeDate(article.updatedDate),
        tags: article.tags,
        kind: normalizeArticleKind(article.kind),
        status: normalizeArticleStatus(article.status),
        category: normalizeOptionalString(article.category),
        series: normalizeOptionalString(article.series),
        featured: Boolean(article.featured),
        readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(article.content) / 450)),
        sourceLinks: article.sourceLinks || [],
        revisionNotes: article.revisionNotes || [],
    };
}

function getArticleIndexPath(): string | null {
    const root = getEditorDataRoot();
    return root ? path.join(root, 'indexes', 'articles.json') : null;
}

function getFreshArticleIndex(): ArticleIndexEntry[] | null {
    const indexPath = getArticleIndexPath();
    if (!indexPath || !fs.existsSync(indexPath)) return null;

    try {
        const index = parseArticleIndex(JSON.parse(fs.readFileSync(indexPath, 'utf8')));
        const manifestUpdatedAt = readEditorDataManifest().resources.articles?.updatedAt;
        return index && manifestUpdatedAt === index.sourceUpdatedAt ? index.articles : null;
    } catch {
        return null;
    }
}

async function getFreshArticleIndexAsync(): Promise<ArticleIndexEntry[] | null> {
    const indexPath = getArticleIndexPath();
    if (!indexPath) return null;

    try {
        const [raw, manifest] = await Promise.all([
            fsPromises.readFile(indexPath, 'utf8'),
            readEditorDataManifestAsync(),
        ]);
        const index = parseArticleIndex(JSON.parse(raw));
        const manifestUpdatedAt = manifest.resources.articles?.updatedAt;
        return index && manifestUpdatedAt === index.sourceUpdatedAt ? index.articles : null;
    } catch {
        return null;
    }
}

function comparePostsByDateDescending(a: PostMeta, b: PostMeta): number {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
}

let runtimePostsCache: PostMeta[] | null = null;
let runtimePostsCacheTime = 0;
const RUNTIME_CACHE_TTL = 5_000;

function resetRuntimePostsCache(): void {
    runtimePostsCache = null;
    runtimePostsCacheTime = 0;
}

registerEditorRuntimeCacheReset(resetRuntimePostsCache);

function getRuntimePosts(): PostMeta[] {
    const now = Date.now();
    if (runtimePostsCache && now - runtimePostsCacheTime < RUNTIME_CACHE_TTL) {
        return runtimePostsCache;
    }

    const indexedPosts = getFreshArticleIndex();
    const posts = indexedPosts
        ? indexedPosts.filter((post) => isPublicArticleStatus(post.status))
        : readArticlesFromDisk()
            .filter((article) => isPublicArticleStatus(article.status))
            .map(mapArticleToPostMeta)
            .sort(comparePostsByDateDescending);

    runtimePostsCache = posts;
    runtimePostsCacheTime = now;
    return posts;
}

async function getRuntimePostsAsync(): Promise<PostMeta[]> {
    const now = Date.now();
    if (runtimePostsCache && now - runtimePostsCacheTime < RUNTIME_CACHE_TTL) {
        return runtimePostsCache;
    }

    const indexedPosts = await getFreshArticleIndexAsync();
    const posts = indexedPosts
        ? indexedPosts.filter((post) => isPublicArticleStatus(post.status))
        : (await readArticlesFromDiskAsync())
            .filter((article) => isPublicArticleStatus(article.status))
            .map(mapArticleToPostMeta)
            .sort(comparePostsByDateDescending);

    runtimePostsCache = posts;
    runtimePostsCacheTime = now;
    return posts;
}

async function getRuntimeSearchablePostsAsync(): Promise<SearchablePost[]> {
    return (await readArticlesFromDiskAsync())
        .filter((article) => isPublicArticleStatus(article.status))
        .map((article) => ({
            meta: mapArticleToPostMeta(article),
            content: article.content,
        }))
        .sort((first, second) => comparePostsByDateDescending(first.meta, second.meta));
}

let seedPostsCache: PostMeta[] | null = null;
let seedPostsCacheTime = 0;
const SEED_CACHE_TTL = 60_000;

export function resetSeedPostsCache(): void {
    seedPostsCache = null;
    seedPostsCacheTime = 0;
}

registerEditorRuntimeCacheReset(resetSeedPostsCache);

function getSeedPosts(): PostMeta[] {
    const now = Date.now();
    if (seedPostsCache && now - seedPostsCacheTime < SEED_CACHE_TTL) {
        return seedPostsCache;
    }

    let files: string[] = [];

    if (!fs.existsSync(contentDir)) {
        return [];
    }

    function findMdFiles(dir: string) {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            if (fs.statSync(fullPath).isDirectory()) {
                findMdFiles(fullPath);
            } else if (item.endsWith('.md')) {
                files.push(fullPath);
            }
        }
    }

    findMdFiles(contentDir);

    const result = files
        .map((file) => {
            const fileContent = fs.readFileSync(file, 'utf8');
            const { data, content } = parseRawMarkdownFrontmatter(fileContent);
            const relativePath = path.relative(contentDir, file);
            const sluggablePath = relativePath.replace(/\\/g, '/').replace(/\.md$/, '');

            return {
                slug: sluggablePath,
                slugArray: sluggablePath.split('/'),
                title: normalizeString(data.title, path.basename(file, '.md')),
                date: normalizeDate(data.date),
                description: normalizeString(data.description),
                updatedDate: normalizeDate(data.updatedDate),
                tags: normalizeStringArray(data.tags),
                kind: normalizeArticleKind(data.kind),
                status: normalizeArticleStatus(data.status),
                category: normalizeOptionalString(data.category),
                series: normalizeOptionalString(data.series),
                featured: Boolean(data.featured),
                readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(content) / 450)),
                sourceLinks: normalizeSourceLinks(data.sourceLinks),
                revisionNotes: normalizeRevisionNotes(data.revisionNotes),
            };
        })
        .filter((post) => isPublicArticleStatus(post.status))
        .sort(comparePostsByDateDescending);

    seedPostsCache = result;
    seedPostsCacheTime = Date.now();
    return result;
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
    let items: fs.Dirent[];

    try {
        items = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }

        throw error;
    }

    const files = await Promise.all(items.map(async (item) => {
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
            return findMarkdownFiles(fullPath);
        }

        return item.isFile() && item.name.endsWith('.md') ? [fullPath] : [];
    }));

    return files.flat();
}

async function getSeedPostsAsync(): Promise<PostMeta[]> {
    const now = Date.now();
    if (seedPostsCache && now - seedPostsCacheTime < SEED_CACHE_TTL) {
        return seedPostsCache;
    }

    const files = await findMarkdownFiles(contentDir);
    const result = (await Promise.all(files.map(async (file) => {
        const fileContent = await fsPromises.readFile(file, 'utf8');
        const { data, content } = parseRawMarkdownFrontmatter(fileContent);
        const relativePath = path.relative(contentDir, file);
        const sluggablePath = relativePath.replace(/\\/g, '/').replace(/\.md$/, '');

        return {
            slug: sluggablePath,
            slugArray: sluggablePath.split('/'),
            title: normalizeString(data.title, path.basename(file, '.md')),
            date: normalizeDate(data.date),
            description: normalizeString(data.description),
            updatedDate: normalizeDate(data.updatedDate),
            tags: normalizeStringArray(data.tags),
            kind: normalizeArticleKind(data.kind),
            status: normalizeArticleStatus(data.status),
            category: normalizeOptionalString(data.category),
            series: normalizeOptionalString(data.series),
            featured: Boolean(data.featured),
            readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(content) / 450)),
            sourceLinks: normalizeSourceLinks(data.sourceLinks),
            revisionNotes: normalizeRevisionNotes(data.revisionNotes),
        };
    })))
        .filter((post) => isPublicArticleStatus(post.status))
        .sort(comparePostsByDateDescending);

    seedPostsCache = result;
    seedPostsCacheTime = Date.now();
    return result;
}

async function getSeedSearchablePostsAsync(): Promise<SearchablePost[]> {
    const files = await findMarkdownFiles(contentDir);
    const result = (await Promise.all(files.map(async (file) => {
        const fileContent = await fsPromises.readFile(file, 'utf8');
        const { data, content } = parseRawMarkdownFrontmatter(fileContent);
        const relativePath = path.relative(contentDir, file);
        const sluggablePath = relativePath.replace(/\\/g, '/').replace(/\.md$/, '');
        const meta: PostMeta = {
            slug: sluggablePath,
            slugArray: sluggablePath.split('/'),
            title: normalizeString(data.title, path.basename(file, '.md')),
            date: normalizeDate(data.date),
            description: normalizeString(data.description),
            updatedDate: normalizeDate(data.updatedDate),
            tags: normalizeStringArray(data.tags),
            kind: normalizeArticleKind(data.kind),
            status: normalizeArticleStatus(data.status),
            category: normalizeOptionalString(data.category),
            series: normalizeOptionalString(data.series),
            featured: Boolean(data.featured),
            readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(content) / 450)),
            sourceLinks: normalizeSourceLinks(data.sourceLinks),
            revisionNotes: normalizeRevisionNotes(data.revisionNotes),
        };

        return {
            meta,
            content,
        };
    })))
        .filter((post) => isPublicArticleStatus(post.meta.status))
        .sort((first, second) => comparePostsByDateDescending(first.meta, second.meta));

    return result;
}

function getRuntimePostBySlugArray(slugArray: string[]) {
    if (slugArray.length !== 1) {
        return null;
    }

    const targetSlug = slugArray[0];
    const article = readArticlesFromDisk().find((candidate) => createRuntimeSlug(candidate) === targetSlug);

    if (!article) {
        return null;
    }

    if (!isPublicArticleStatus(article.status)) {
        return null;
    }

    return {
        meta: mapArticleToPostMeta(article),
        content: article.content,
    };
}

async function getRuntimePostBySlugArrayAsync(slugArray: string[]) {
    if (slugArray.length !== 1) {
        return null;
    }

    const targetSlug = slugArray[0];
    const article = (await readArticlesFromDiskAsync()).find((candidate) => createRuntimeSlug(candidate) === targetSlug);

    if (!article) {
        return null;
    }

    if (!isPublicArticleStatus(article.status)) {
        return null;
    }

    return {
        meta: mapArticleToPostMeta(article),
        content: article.content,
    };
}

function getSeedPostBySlugArray(slugArray: string[]) {
    const relPath = slugArray.join('/');
    const targetPath = path.join(contentDir, relPath + '.md');
    const targetIndexPath = path.join(contentDir, relPath, 'index.md');

    const resolvedBase = path.resolve(contentDir) + path.sep;
    if (
        !path.resolve(targetPath).startsWith(resolvedBase) ||
        !path.resolve(targetIndexPath).startsWith(resolvedBase)
    ) {
        return null;
    }

    let matchedFile = '';

    if (fs.existsSync(targetPath)) {
        matchedFile = targetPath;
    } else if (fs.existsSync(targetIndexPath)) {
        matchedFile = targetIndexPath;
    }

    if (!matchedFile) {
        return null;
    }

    const fileContent = fs.readFileSync(matchedFile, 'utf8');
    const { data, content } = parseRawMarkdownFrontmatter(fileContent);
    const status = normalizeArticleStatus(data.status);

    if (!isPublicArticleStatus(status)) {
        return null;
    }

    return {
        meta: {
            slug: relPath,
            slugArray,
            title: normalizeString(data.title, slugArray[slugArray.length - 1]),
            date: normalizeDate(data.date),
            description: normalizeString(data.description),
            updatedDate: normalizeDate(data.updatedDate),
            tags: normalizeStringArray(data.tags),
            kind: normalizeArticleKind(data.kind),
            status,
            category: normalizeOptionalString(data.category),
            series: normalizeOptionalString(data.series),
            featured: Boolean(data.featured),
            readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(content) / 450)),
            sourceLinks: normalizeSourceLinks(data.sourceLinks),
            revisionNotes: normalizeRevisionNotes(data.revisionNotes),
        },
        content,
    };
}

async function getSeedPostBySlugArrayAsync(slugArray: string[]) {
    const relPath = slugArray.join('/');
    const targetPath = path.join(contentDir, relPath + '.md');
    const targetIndexPath = path.join(contentDir, relPath, 'index.md');

    const resolvedBase = path.resolve(contentDir) + path.sep;
    if (
        !path.resolve(targetPath).startsWith(resolvedBase) ||
        !path.resolve(targetIndexPath).startsWith(resolvedBase)
    ) {
        return null;
    }

    let matchedFile = '';

    try {
        await fsPromises.access(targetPath);
        matchedFile = targetPath;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    if (!matchedFile) {
        try {
            await fsPromises.access(targetIndexPath);
            matchedFile = targetIndexPath;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    if (!matchedFile) {
        return null;
    }

    const fileContent = await fsPromises.readFile(matchedFile, 'utf8');
    const { data, content } = parseRawMarkdownFrontmatter(fileContent);
    const status = normalizeArticleStatus(data.status);

    if (!isPublicArticleStatus(status)) {
        return null;
    }

    return {
        meta: {
            slug: relPath,
            slugArray,
            title: normalizeString(data.title, slugArray[slugArray.length - 1]),
            date: normalizeDate(data.date),
            description: normalizeString(data.description),
            updatedDate: normalizeDate(data.updatedDate),
            tags: normalizeStringArray(data.tags),
            kind: normalizeArticleKind(data.kind),
            status,
            category: normalizeOptionalString(data.category),
            series: normalizeOptionalString(data.series),
            featured: Boolean(data.featured),
            readingMinutes: Math.max(1, Math.ceil(countMarkdownWords(content) / 450)),
            sourceLinks: normalizeSourceLinks(data.sourceLinks),
            revisionNotes: normalizeRevisionNotes(data.revisionNotes),
        },
        content,
    };
}

export function getPosts(): PostMeta[] {
    const livePosts = getLivePosts();
    if (livePosts) return livePosts;
    if (isRuntimeArticleSourceEnabled()) {
        if (isRuntimeArticleDataAvailable()) {
            return getRuntimePosts();
        }
    }
    return getSeedPosts();
}

function mapLiveArticleToPostMeta(article: Article): PostMeta {
    const post = mapArticleToPostMeta(article);
    return { ...post, slugArray: [post.slug] };
}

function decodeSlugArray(slugArray: string[]): string[] | null {
    try {
        return slugArray.map((segment) => decodeURIComponent(segment));
    } catch {
        return null;
    }
}

/**
 * Reads one article out of an already loaded live snapshot. Callers that render a whole request
 * (body, related posts, settings) use these helpers so every part of the response comes from the
 * same release instead of re-reading the live pointer per field.
 */
export function getLivePostFromSnapshot(
    live: PublicLiveSnapshot,
    slugArray: string[]
): SearchablePost | null {
    const decoded = decodeSlugArray(slugArray);

    if (!decoded || decoded.length !== 1) {
        return null;
    }

    const article = live.articles.find((item) => createRuntimeSlug(item) === decoded[0]);
    return article ? { meta: mapLiveArticleToPostMeta(article), content: article.content } : null;
}

export function getLivePostsFromSnapshot(live: PublicLiveSnapshot): PostMeta[] {
    return live.articles.map(mapLiveArticleToPostMeta).sort(comparePostsByDateDescending);
}

export function getLiveSearchablePostsFromSnapshot(live: PublicLiveSnapshot): SearchablePost[] {
    return live.articles
        .map((article) => ({ meta: mapLiveArticleToPostMeta(article), content: article.content }))
        .sort((left, right) => comparePostsByDateDescending(left.meta, right.meta));
}

export function getLivePosts(): PostMeta[] | null {
    if (!isLiveReaderRuntime()) return null;
    return getLivePostsFromSnapshot(getPublicLiveSnapshot());
}

export async function getPostsAsync(): Promise<PostMeta[]> {
    const livePosts = getLivePosts();
    if (livePosts) return livePosts;
    if (isRuntimeArticleSourceEnabled()) {
        if (await isRuntimeArticleDataAvailableAsync()) {
            return getRuntimePostsAsync();
        }
    }
    return getSeedPostsAsync();
}

export async function getSearchablePostsAsync(): Promise<SearchablePost[]> {
    if (isLiveReaderRuntime()) {
        return getLiveSearchablePostsFromSnapshot(getPublicLiveSnapshot());
    }
    if (isRuntimeArticleSourceEnabled()) {
        if (await isRuntimeArticleDataAvailableAsync()) {
            return getRuntimeSearchablePostsAsync();
        }
    }
    return getSeedSearchablePostsAsync();
}

export function getPostBySlugArray(slugArray: string[]) {
    if (isLiveReaderRuntime()) {
        return getLivePostFromSnapshot(getPublicLiveSnapshot(), slugArray);
    }
    const decoded = decodeSlugArray(slugArray);

    if (!decoded) {
        return null;
    }

    if (isRuntimeArticleSourceEnabled()) {
        if (isRuntimeArticleDataAvailable()) {
            return getRuntimePostBySlugArray(decoded);
        }
    }
    return getSeedPostBySlugArray(decoded);
}

export async function getPostBySlugArrayAsync(slugArray: string[]) {
    if (isLiveReaderRuntime()) {
        return getLivePostFromSnapshot(getPublicLiveSnapshot(), slugArray);
    }
    const decoded = decodeSlugArray(slugArray);

    if (!decoded) {
        return null;
    }

    if (isRuntimeArticleSourceEnabled()) {
        if (await isRuntimeArticleDataAvailableAsync()) {
            return getRuntimePostBySlugArrayAsync(decoded);
        }
    }
    return getSeedPostBySlugArrayAsync(decoded);
}

export function getRelatedPostsFromList(posts: PostMeta[], meta: PostMeta, limit = 4): PostMeta[] {
    return posts
        .filter((post) => post.slug !== meta.slug && !post.slugArray.includes('navigation'))
        .map((post) => ({
            post,
            score: getRelatedScore(meta, post),
        }))
        .filter((item) => item.score > 0)
        .sort((first, second) => second.score - first.score || second.post.date.localeCompare(first.post.date))
        .slice(0, limit)
        .map((item) => item.post);
}

export function getRelatedPosts(meta: PostMeta, limit = 4): PostMeta[] {
    return getRelatedPostsFromList(getPosts(), meta, limit);
}

export async function getRelatedPostsAsync(meta: PostMeta, limit = 4): Promise<PostMeta[]> {
    return getRelatedPostsFromList(await getPostsAsync(), meta, limit);
}

function getRelatedScore(current: PostMeta, candidate: PostMeta): number {
    let score = 0;

    if (current.series && candidate.series === current.series) {
        score += 8;
    }

    if (current.category && candidate.category === current.category) {
        score += 4;
    }

    const currentTags = new Set(current.tags);

    for (const tag of candidate.tags) {
        if (currentTags.has(tag)) {
            score += 2;
        }
    }

    if (candidate.kind === current.kind) {
        score += 1;
    }

    return score;
}
