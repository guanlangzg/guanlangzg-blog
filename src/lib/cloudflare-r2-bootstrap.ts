import { createHash } from 'node:crypto';
import { isRecord } from '@/lib/article-data';
import {
    getR2BackupStatus,
    saveEditableR2BackupSettings,
    type R2BackupStatus,
    type SafeR2BackupSettings,
} from '@/lib/r2-backup-storage';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const R2_BUCKET_ITEM_READ_PERMISSION_GROUP_NAME = 'Workers R2 Storage Bucket Item Read';
const R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_NAME = 'Workers R2 Storage Bucket Item Write';

export interface CloudflareR2BootstrapInput {
    authEmail: string;
    globalApiKey: string;
    accountId: string;
    bucket: string;
    prefix: string;
    snapshotOnWrite: boolean;
}

export interface CloudflareR2BootstrapResult {
    settings: SafeR2BackupSettings;
    status: R2BackupStatus;
    bucketCreated: boolean;
    tokenName: string;
}

interface CloudflareAuth {
    authEmail: string;
    globalApiKey: string;
}

interface CloudflareApiEnvelope<T> {
    success?: boolean;
    result?: T;
    errors?: Array<{
        code?: number | string;
        message?: string;
    }>;
}

export class CloudflareR2BootstrapError extends Error {
    constructor(
        message: string,
        public readonly statusCode = 400
    ) {
        super(message);
        this.name = 'CloudflareR2BootstrapError';
    }
}

function trimBootstrapInput(input: CloudflareR2BootstrapInput): CloudflareR2BootstrapInput {
    return {
        ...input,
        authEmail: input.authEmail.trim(),
        globalApiKey: input.globalApiKey.trim(),
        accountId: input.accountId.trim().toLowerCase(),
        bucket: input.bucket.trim(),
        prefix: input.prefix.trim(),
    };
}

function assertBootstrapInput(input: CloudflareR2BootstrapInput): void {
    if (!input.authEmail || !input.authEmail.includes('@')) {
        throw new CloudflareR2BootstrapError('请填写 Cloudflare 登录邮箱。');
    }

    if (!input.globalApiKey) {
        throw new CloudflareR2BootstrapError('请填写 Cloudflare Global API Key。');
    }

    if (!/^[a-f0-9]{32}$/i.test(input.accountId)) {
        throw new CloudflareR2BootstrapError('请填写 32 位 Cloudflare Account ID。');
    }

    if (!input.bucket) {
        throw new CloudflareR2BootstrapError('请填写 R2 Bucket 名称。');
    }
}

function createCloudflareHeaders(auth: CloudflareAuth): Headers {
    return new Headers({
        'X-Auth-Email': auth.authEmail,
        'X-Auth-Key': auth.globalApiKey,
        'Content-Type': 'application/json',
    });
}

function createCloudflareErrorMessage<T>(payload: CloudflareApiEnvelope<T> | null, fallback: string): string {
    const messages = payload?.errors
        ?.map((error) => error.message?.trim())
        .filter((message): message is string => Boolean(message));

    return messages?.length ? messages.join('；') : fallback;
}

async function requestCloudflareApi<T>(
    auth: CloudflareAuth,
    method: string,
    path: string,
    body?: unknown
): Promise<T> {
    const response = await fetch(`${CLOUDFLARE_API_BASE_URL}${path}`, {
        method,
        headers: createCloudflareHeaders(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as CloudflareApiEnvelope<T> | null;

    if (!response.ok || !payload?.success) {
        throw new CloudflareR2BootstrapError(
            createCloudflareErrorMessage(payload, 'Cloudflare API 请求失败。'),
            response.status >= 400 && response.status < 500 ? 400 : 502
        );
    }

    return payload.result as T;
}

function parseBucketNames(value: unknown): string[] {
    if (!isRecord(value) || !Array.isArray(value.buckets)) {
        throw new CloudflareR2BootstrapError('Cloudflare R2 Bucket 列表响应格式无效。', 502);
    }

    return value.buckets
        .map((bucket) => isRecord(bucket) && typeof bucket.name === 'string' ? bucket.name : null)
        .filter((name): name is string => Boolean(name));
}

async function ensureR2Bucket(auth: CloudflareAuth, accountId: string, bucket: string): Promise<boolean> {
    const bucketList = await requestCloudflareApi<unknown>(auth, 'GET', `/accounts/${accountId}/r2/buckets`);
    const bucketNames = parseBucketNames(bucketList);

    if (bucketNames.includes(bucket)) {
        return false;
    }

    await requestCloudflareApi(auth, 'POST', `/accounts/${accountId}/r2/buckets`, {
        name: bucket,
    });

    return true;
}

function parseCreatedToken(value: unknown): { id: string; value: string } {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.value !== 'string') {
        throw new CloudflareR2BootstrapError('Cloudflare Token 创建响应格式无效。', 502);
    }

    return {
        id: value.id,
        value: value.value,
    };
}

function parseR2BucketPermissionGroupIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        throw new CloudflareR2BootstrapError('Cloudflare 权限组响应格式无效。', 502);
    }

    const permissionGroups = value
        .map((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
            ? { id: item.id, name: item.name }
            : null)
        .filter((item): item is { id: string; name: string } => Boolean(item));
    const readGroup = permissionGroups.find((item) => item.name === R2_BUCKET_ITEM_READ_PERMISSION_GROUP_NAME);
    const writeGroup = permissionGroups.find((item) => item.name === R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_NAME);

    if (!readGroup || !writeGroup) {
        throw new CloudflareR2BootstrapError('Cloudflare 账号缺少 R2 对象读写权限组。', 400);
    }

    return [readGroup.id, writeGroup.id];
}

function createR2BucketResource(accountId: string, bucket: string): string {
    return `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`;
}

async function createR2Token(
    auth: CloudflareAuth,
    accountId: string,
    bucket: string,
    tokenName: string,
    permissionGroupIds: string[]
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
    const token = parseCreatedToken(await requestCloudflareApi(auth, 'POST', '/user/tokens', {
        name: tokenName,
        policies: [
            {
                effect: 'allow',
                resources: {
                    [createR2BucketResource(accountId, bucket)]: '*',
                },
                permission_groups: permissionGroupIds.map((id) => ({ id })),
            },
        ],
    }));

    // R2 derives S3 credentials from an API token: access key id is the token id,
    // secret access key is the SHA-256 of the token value.
    // https://developers.cloudflare.com/r2/api/tokens/
    return {
        accessKeyId: token.id,
        secretAccessKey: createHash('sha256').update(token.value).digest('hex'),
    };
}

async function deleteR2Token(auth: CloudflareAuth, tokenId: string): Promise<void> {
    await requestCloudflareApi(auth, 'DELETE', `/user/tokens/${tokenId}`);
}

async function deleteR2Bucket(auth: CloudflareAuth, accountId: string, bucket: string): Promise<void> {
    await requestCloudflareApi(auth, 'DELETE', `/accounts/${accountId}/r2/buckets/${bucket}`);
}

export async function bootstrapCloudflareR2Settings(
    rawInput: CloudflareR2BootstrapInput,
    options: { expectedRevision?: string | null } = {}
): Promise<CloudflareR2BootstrapResult> {
    const input = trimBootstrapInput(rawInput);
    assertBootstrapInput(input);

    const auth = {
        authEmail: input.authEmail,
        globalApiKey: input.globalApiKey,
    };
    let bucketCreated = false;
    let accessKeyId = '';
    let settingsSaved = false;

    try {
        await requestCloudflareApi(auth, 'GET', `/accounts/${input.accountId}`);
        bucketCreated = await ensureR2Bucket(auth, input.accountId, input.bucket);
        const permissionGroupIds = parseR2BucketPermissionGroupIds(
            await requestCloudflareApi(auth, 'GET', '/user/tokens/permission_groups')
        );

        const tokenName = `blog-navigation-r2-${Date.now()}`;
        const token = await createR2Token(auth, input.accountId, input.bucket, tokenName, permissionGroupIds);
        accessKeyId = token.accessKeyId;

        const settings = await withRuntimeDataRootLock(() => saveEditableR2BackupSettings(
            {
                enabled: true,
                accountId: input.accountId,
                bucket: input.bucket,
                accessKeyId: token.accessKeyId,
                secretAccessKey: token.secretAccessKey,
                prefix: input.prefix,
                endpoint: '',
                snapshotOnWrite: input.snapshotOnWrite,
            },
            { expectedRevision: options.expectedRevision }
        ));
        settingsSaved = true;

        return {
            settings,
            status: getR2BackupStatus(),
            bucketCreated,
            tokenName,
        };
    } catch (error) {
        if (settingsSaved) {
            throw error;
        }

        if (accessKeyId) {
            await deleteR2Token(auth, accessKeyId).catch(() => undefined);
        }

        if (bucketCreated) {
            await deleteR2Bucket(auth, input.accountId, input.bucket).catch(() => undefined);
        }

        throw error;
    }
}
