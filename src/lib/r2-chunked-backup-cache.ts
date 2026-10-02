import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';
import { isRecord } from '@/lib/article-data';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';

const CACHE_FILE_NAME = '.r2-v2-upload-cache.json';
const CACHE_VERSION = 1;

interface R2ChunkedUploadCacheEntry {
    sha256: string;
    size: number;
    uploadedAt: string;
}

interface R2ChunkedUploadCache {
    version: typeof CACHE_VERSION;
    objects: Record<string, R2ChunkedUploadCacheEntry>;
}

function getCacheFilePath(): string {
    return path.join(getRuntimeDataRootPath(), CACHE_FILE_NAME);
}

function isEntry(value: unknown): value is R2ChunkedUploadCacheEntry {
    return (
        isRecord(value) &&
        typeof value.sha256 === 'string' &&
        typeof value.size === 'number' &&
        Number.isInteger(value.size) &&
        value.size >= 0 &&
        typeof value.uploadedAt === 'string'
    );
}

function parseCache(value: unknown): R2ChunkedUploadCache | null {
    if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.objects)) {
        return null;
    }

    const objects: Record<string, R2ChunkedUploadCacheEntry> = {};

    for (const [key, entry] of Object.entries(value.objects)) {
        if (!isEntry(entry)) {
            return null;
        }

        objects[key] = entry;
    }

    return {
        version: CACHE_VERSION,
        objects,
    };
}

export function readR2ChunkedUploadCache(): R2ChunkedUploadCache {
    const filePath = getCacheFilePath();

    if (!fs.existsSync(filePath)) {
        return {
            version: CACHE_VERSION,
            objects: {},
        };
    }

    try {
        return parseCache(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown) ?? {
            version: CACHE_VERSION,
            objects: {},
        };
    } catch {
        return {
            version: CACHE_VERSION,
            objects: {},
        };
    }
}

export function isR2ChunkedUploadCacheHit(
    cache: R2ChunkedUploadCache,
    key: string,
    sha256: string,
    size: number
): boolean {
    const entry = cache.objects[key];

    return Boolean(entry && entry.sha256 === sha256 && entry.size === size);
}

export function rememberR2ChunkedUploadedObject(
    cache: R2ChunkedUploadCache,
    key: string,
    sha256: string,
    size: number,
    now = new Date()
): void {
    cache.objects[key] = {
        sha256,
        size,
        uploadedAt: now.toISOString(),
    };
}

export function writeR2ChunkedUploadCache(cache: R2ChunkedUploadCache): void {
    writeJsonAtomically(getCacheFilePath(), cache);
}
