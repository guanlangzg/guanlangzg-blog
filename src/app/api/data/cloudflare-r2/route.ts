import { NextRequest, NextResponse } from 'next/server';
import {
    createJsonBodyParseErrorResponse,
    createJsonBodyTooLargeResponse,
    EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES,
    JsonBodyParseError,
    JsonBodyTooLargeError,
    readJsonBodyWithLimit,
} from '@/lib/api-json-body';
import {
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import { getRemoteBackupQueueSnapshot } from '@/lib/editor-remote-backup';
import { recordEditorAuditEvent } from '@/lib/editor-audit-log';
import {
    getEditableR2BackupSettings,
    getR2BackupStatus,
    getR2BackupSettingsRevision,
    R2BackupSettingsInvalidError,
    R2BackupSettingsRevisionMismatchError,
    saveEditableR2BackupSettings,
    type EditableR2BackupSettings,
} from '@/lib/r2-backup-storage';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

type CloudflareR2RequestBody = {
    settings?: Partial<Record<keyof EditableR2BackupSettings, unknown>>;
    revision?: unknown;
};

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function parseSettings(value: CloudflareR2RequestBody['settings']): EditableR2BackupSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return {
        enabled: value.enabled === true,
        accountId: asString(value.accountId),
        bucket: asString(value.bucket),
        accessKeyId: asString(value.accessKeyId),
        secretAccessKey: asString(value.secretAccessKey),
        prefix: asString(value.prefix),
        endpoint: asString(value.endpoint),
        snapshotOnWrite: value.snapshotOnWrite === true,
    };
}

function createInvalidR2SettingsResponse(error: unknown): NextResponse | null {
    if (!(error instanceof R2BackupSettingsInvalidError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: 'Cloudflare R2 配置文件损坏，请修复或删除后重试。',
        },
        { status: 500 }
    );
}

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    try {
        const persistent = await hasWritableRuntimeDataRoot();
        const queueSnapshot = await getRemoteBackupQueueSnapshot();

        return NextResponse.json({
            persistent,
            settings: getEditableR2BackupSettings(),
            revision: getR2BackupSettingsRevision(),
            status: getR2BackupStatus(),
            ...queueSnapshot,
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const invalidResponse = createInvalidR2SettingsResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }
}

export async function PUT(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    let body: CloudflareR2RequestBody | null;

    try {
        body = await readJsonBodyWithLimit<CloudflareR2RequestBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    const settings = parseSettings(body?.settings);

    if (!settings) {
        return NextResponse.json(
            {
                message: 'Cloudflare R2 配置格式无效。',
            },
            { status: 400 }
        );
    }

    try {
        const expectedRevision = typeof body?.revision === 'string' ? body.revision : null;
        const savedSettings = await withRuntimeDataRootLock(() => {
            return saveEditableR2BackupSettings(settings, { expectedRevision });
        });
        recordEditorAuditEvent({
            action: 'r2.settings.update',
            resource: 'cloudflare-r2',
            outcome: 'success',
            metadata: {
                enabled: savedSettings.enabled,
                configured: getR2BackupStatus().configured,
                bucket: savedSettings.bucket || null,
                prefix: savedSettings.prefix,
            },
        });
        const queueSnapshot = await getRemoteBackupQueueSnapshot();

        return NextResponse.json({
            success: true,
            settings: savedSettings,
            revision: getR2BackupSettingsRevision(),
            status: getR2BackupStatus(),
            ...queueSnapshot,
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const invalidResponse = createInvalidR2SettingsResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        if (error instanceof R2BackupSettingsRevisionMismatchError) {
            const queueSnapshot = await getRemoteBackupQueueSnapshot();

            return NextResponse.json(
                {
                    message: 'Cloudflare R2 配置已被其他会话更新，请刷新后重试。',
                    settings: getEditableR2BackupSettings(),
                    revision: error.currentRevision,
                    status: getR2BackupStatus(),
                    ...queueSnapshot,
                },
                { status: 409 }
            );
        }

        const knownPrefixes = [
            '启用 R2 备份时必须填写',
            'Cloudflare R2 Endpoint',
        ];
        const message = error instanceof Error && knownPrefixes.some((prefix) => error.message.startsWith(prefix))
            ? error.message
            : 'Cloudflare R2 配置保存失败，请检查配置格式。';

        return NextResponse.json(
            { message },
            { status: 400 }
        );
    }
}
