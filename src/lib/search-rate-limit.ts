import { NextRequest, NextResponse } from 'next/server';
import {
    getRequestClientId,
    isRequestClientIdReliable,
} from '@/lib/request-client';

const SEARCH_REQUEST_LIMIT = 30;
const SEARCH_REQUEST_WINDOW_MS = 60 * 1000;
const SEARCH_BUCKET_LIMIT = 1_000;

interface SearchRateLimitBucket {
    count: number;
    resetAt: number;
}

const searchRateLimitBuckets = new Map<string, SearchRateLimitBucket>();

function pruneExpiredSearchRateLimitBuckets(): void {
    const now = Date.now();

    for (const [key, bucket] of searchRateLimitBuckets) {
        if (bucket.resetAt <= now) {
            searchRateLimitBuckets.delete(key);
        }
    }
}

function pruneOldestSearchRateLimitBucket(): void {
    const oldestKey = searchRateLimitBuckets.keys().next().value as string | undefined;

    if (oldestKey) {
        searchRateLimitBuckets.delete(oldestKey);
    }
}

function getActiveSearchRateLimitBucket(clientId: string): SearchRateLimitBucket | null {
    const bucket = searchRateLimitBuckets.get(clientId);

    if (!bucket) {
        return null;
    }

    if (bucket.resetAt <= Date.now()) {
        searchRateLimitBuckets.delete(clientId);
        return null;
    }

    return bucket;
}

function createSearchRateLimitResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '搜索请求过于频繁，请稍后再试。',
        },
        { status: 429 }
    );
}

function createClientIdentityConfigurationResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '生产环境必须配置 TRUSTED_PROXY_IPS 后才能使用搜索。',
        },
        { status: 503 }
    );
}

export function getSearchRateLimitResponse(request: NextRequest): NextResponse | null {
    if (!isRequestClientIdReliable()) {
        return createClientIdentityConfigurationResponse();
    }

    const clientId = getRequestClientId(request);
    const bucket = getActiveSearchRateLimitBucket(clientId);

    if (!bucket) {
        pruneExpiredSearchRateLimitBuckets();

        if (searchRateLimitBuckets.size >= SEARCH_BUCKET_LIMIT) {
            pruneOldestSearchRateLimitBucket();
        }

        searchRateLimitBuckets.set(clientId, {
            count: 1,
            resetAt: Date.now() + SEARCH_REQUEST_WINDOW_MS,
        });
        return null;
    }

    if (bucket.count >= SEARCH_REQUEST_LIMIT) {
        return createSearchRateLimitResponse();
    }

    bucket.count += 1;
    return null;
}

export function resetSearchRateLimitForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetSearchRateLimitForTests must not be called in production.');
    }

    searchRateLimitBuckets.clear();
}
