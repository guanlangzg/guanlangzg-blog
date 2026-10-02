import { createHash } from 'node:crypto';
import {
    downloadMediaAssetFromR2,
} from '@/lib/r2-backup-storage';
import {
    isEditorMediaAssetPresent,
    readEditorMediaFile,
    writeRestoredEditorMediaFile,
    type EditorMediaManifest,
} from '@/lib/editor-media-storage';

export interface EditorMediaRestoreFailure {
    path: string;
    message: string;
}

export interface EditorMediaRestoreResult {
    total: number;
    restored: number;
    skipped: number;
    failed: number;
    failures: EditorMediaRestoreFailure[];
}

export interface EditorMediaRestoreData {
    manifest: EditorMediaManifest;
    files: Array<{
        path: string;
        bytes: Uint8Array;
    }>;
}

export class EditorMediaRestoreDownloadError extends Error {
    constructor(public readonly result: EditorMediaRestoreResult) {
        super(`Failed to prepare ${result.failed} media file(s) from R2.`);
        this.name = 'EditorMediaRestoreDownloadError';
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : '媒体文件恢复失败。';
}

function hashBytes(value: Uint8Array): string {
    return createHash('sha256')
        .update(value)
        .digest('hex');
}

async function readVerifiedLocalMediaBytes(asset: EditorMediaManifest['assets'][number]): Promise<Uint8Array | null> {
    const bytes = await readEditorMediaFile(asset);

    if (!bytes) {
        return null;
    }

    return hashBytes(bytes) === asset.hash ? bytes : null;
}

export async function materializeEditorMediaRestoreDataFromR2(
    manifest: EditorMediaManifest | undefined
): Promise<{ media: EditorMediaRestoreData | undefined; result: EditorMediaRestoreResult }> {
    const assets = manifest?.assets ?? [];
    const result: EditorMediaRestoreResult = {
        total: assets.length,
        restored: 0,
        skipped: 0,
        failed: 0,
        failures: [],
    };

    if (!manifest) {
        return {
            media: undefined,
            result,
        };
    }

    const files: EditorMediaRestoreData['files'] = [];

    for (const asset of assets) {
        try {
            const localBytes = await readVerifiedLocalMediaBytes(asset);

            if (localBytes) {
                files.push({
                    path: asset.path,
                    bytes: localBytes,
                });
                result.skipped += 1;
                continue;
            }

            const bytes = await downloadMediaAssetFromR2(asset);

            if (hashBytes(bytes) !== asset.hash) {
                throw new Error(`媒体文件校验失败：${asset.path}`);
            }

            files.push({
                path: asset.path,
                bytes,
            });
            result.restored += 1;
        } catch (error) {
            result.failed += 1;
            result.failures.push({
                path: asset.path,
                message: getErrorMessage(error),
            });
        }
    }

    if (result.failed > 0) {
        throw new EditorMediaRestoreDownloadError(result);
    }

    return {
        media: {
            manifest,
            files,
        },
        result,
    };
}

export async function restoreEditorMediaAssetsFromR2(
    manifest: EditorMediaManifest | undefined
): Promise<EditorMediaRestoreResult> {
    const assets = manifest?.assets ?? [];
    const result: EditorMediaRestoreResult = {
        total: assets.length,
        restored: 0,
        skipped: 0,
        failed: 0,
        failures: [],
    };

    for (const asset of assets) {
        try {
            if (await isEditorMediaAssetPresent(asset)) {
                result.skipped += 1;
                continue;
            }

            const bytes = await downloadMediaAssetFromR2(asset);
            await writeRestoredEditorMediaFile(asset, bytes);
            result.restored += 1;
        } catch (error) {
            result.failed += 1;
            result.failures.push({
                path: asset.path,
                message: getErrorMessage(error),
            });
        }
    }

    return result;
}
