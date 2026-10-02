import { NextRequest, NextResponse } from 'next/server';
import {
    getRequestClientId,
    isRequestClientIdReliable,
} from '@/lib/request-client';

const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAILURE_BUCKET_LIMIT = 1_000;

type AuthOperation = 'login' | 'setup';

interface AuthFailureBucket {
    count: number;
    resetAt: number;
}

const authFailureBuckets = new Map<string, AuthFailureBucket>();

function pruneExpiredAuthFailureBuckets(): void {
    const now = Date.now();

    for (const [key, bucket] of authFailureBuckets) {
        if (bucket.resetAt <= now) {
            authFailureBuckets.delete(key);
        }
    }
}

function pruneOldestAuthFailureBucket(): void {
    let oldestKey: string | undefined;
    let oldestResetAt = Infinity;

    for (const [key, bucket] of authFailureBuckets) {
        if (bucket.resetAt < oldestResetAt) {
            oldestResetAt = bucket.resetAt;
            oldestKey = key;
        }
    }

    if (oldestKey) {
        authFailureBuckets.delete(oldestKey);
    }
}

function getAuthFailureBucketKey(request: NextRequest, operation: AuthOperation): string {
    return `${operation}:${getRequestClientId(request)}`;
}

function getActiveAuthFailureBucket(bucketKey: string): AuthFailureBucket | null {
    const bucket = authFailureBuckets.get(bucketKey);

    if (!bucket) {
        return null;
    }

    if (bucket.resetAt <= Date.now()) {
        authFailureBuckets.delete(bucketKey);
        return null;
    }

    return bucket;
}

function createRateLimitResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '尝试次数过多，请稍后再试。',
        },
        { status: 429 }
    );
}

function createClientIdentityConfigurationResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '生产环境必须配置 TRUSTED_PROXY_IPS 后才能使用编辑登录。',
        },
        { status: 503 }
    );
}

export function getEditorAuthRateLimitResponse(
    request: NextRequest,
    operation: AuthOperation
): NextResponse | null {
    if (!isRequestClientIdReliable()) {
        return createClientIdentityConfigurationResponse();
    }

    const bucket = getActiveAuthFailureBucket(getAuthFailureBucketKey(request, operation));

    if (!bucket || bucket.count < AUTH_FAILURE_LIMIT) {
        return null;
    }

    return createRateLimitResponse();
}

export function recordEditorAuthFailure(request: NextRequest, operation: AuthOperation): void {
    const bucketKey = getAuthFailureBucketKey(request, operation);
    const bucket = getActiveAuthFailureBucket(bucketKey);

    if (!bucket) {
        pruneExpiredAuthFailureBuckets();

        if (authFailureBuckets.size >= AUTH_FAILURE_BUCKET_LIMIT) {
            pruneOldestAuthFailureBucket();
        }

        authFailureBuckets.set(bucketKey, {
            count: 1,
            resetAt: Date.now() + AUTH_FAILURE_WINDOW_MS,
        });
        return;
    }

    bucket.count += 1;
}

export function clearEditorAuthFailures(request: NextRequest, operation: AuthOperation): void {
    authFailureBuckets.delete(getAuthFailureBucketKey(request, operation));
}

export function resetEditorAuthRateLimitForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetEditorAuthRateLimitForTests must not be called in production.');
    }

    authFailureBuckets.clear();
}
