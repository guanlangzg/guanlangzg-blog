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
    createEditorBackupStateInvalidResponse,
    createEditorDataFileInvalidResponse,
    createEditorDataLockTimeoutResponse,
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
    ensureEditorSession,
} from '@/lib/editor-api-auth';
import {
    EditorDataRootUnavailableError,
    getEditorDataResourceManifest,
    readSiteSettingsFromDisk,
    writeSiteSettingsToDiskIfRevisionMatches,
} from '@/lib/editor-data-storage';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import { getAppVersionInfo } from '@/lib/app-version';
import { createDefaultSiteSettings, parseSiteSettingsOrThrow, SiteSettingsParseError } from '@/lib/site-settings';
import { invalidatePublicContentCache } from '@/lib/public-cache-invalidation';
import { hasWritableRuntimeDataRoot } from '@/lib/runtime-data-root';

type SettingsRequestBody = {
    settings?: unknown;
    revision?: unknown;
};

export async function GET(request: NextRequest) {
    const authError = await ensureEditorSession(request);

    if (authError) {
        return authError;
    }

    const persistent = await hasWritableRuntimeDataRoot();

    try {
        const settings = readSiteSettingsFromDisk();
        const resourceManifest = getEditorDataResourceManifest('settings', settings);

        return NextResponse.json({
            persistent,
            revision: resourceManifest?.revision ?? null,
            settings,
            version: getAppVersionInfo(),
        });
    } catch (error) {
        if (error instanceof EditorDataRootUnavailableError) {
            return NextResponse.json({
                persistent: false,
                revision: null,
                settings: createDefaultSiteSettings(),
                version: getAppVersionInfo(),
            });
        }

        const invalidResponse = createEditorDataFileInvalidResponse(error);

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

    let body: SettingsRequestBody | null;

    try {
        body = await readJsonBodyWithLimit<SettingsRequestBody>(request, EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
            return createJsonBodyTooLargeResponse();
        }

        if (error instanceof JsonBodyParseError) {
            return createJsonBodyParseErrorResponse();
        }

        throw error;
    }

    let settings;

    try {
        settings = parseSiteSettingsOrThrow(body?.settings);
    } catch (error) {
        if (error instanceof SiteSettingsParseError) {
            return NextResponse.json(
                {
                    message: error.message,
                },
                { status: 400 }
            );
        }

        throw error;
    }

    const expectedRevision = typeof body?.revision === 'string' ? body.revision : null;
    let writeResult;

    try {
        writeResult = await writeSiteSettingsToDiskIfRevisionMatches(settings, expectedRevision);
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const backupStateResponse = createEditorBackupStateInvalidResponse(error);

        if (backupStateResponse) {
            return backupStateResponse;
        }

        const lockTimeoutResponse = createEditorDataLockTimeoutResponse(error);

        if (lockTimeoutResponse) {
            return lockTimeoutResponse;
        }

        const invalidResponse = createEditorDataFileInvalidResponse(error);

        if (invalidResponse) {
            return invalidResponse;
        }

        throw error;
    }

    if (!writeResult.success) {
        return NextResponse.json(
            {
                message: '站点设置已被其他会话更新，请刷新后重试。',
                revision: writeResult.currentManifest?.revision ?? null,
                settings: writeResult.currentValue,
            },
            { status: 409 }
        );
    }

    const remoteBackup = await queueCurrentBackupToRemote({
        reason: 'settings-write',
    });
    invalidatePublicContentCache('settings-write');

    return NextResponse.json({
        success: true,
        settings,
        revision: writeResult.resourceManifest.revision,
        remoteBackup,
        version: getAppVersionInfo(),
    });
}
