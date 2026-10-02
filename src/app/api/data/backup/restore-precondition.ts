import { NextResponse } from 'next/server';
import { EditorBackupRestoreConflictError } from '@/lib/editor-data-backup';
import {
    parseEditorDataManifest,
} from '@/lib/editor-data-storage';
import type { EditorBackupRestorePrecondition } from '@/lib/editor-data-backup';

export function parseRestoreCurrentManifest(value: unknown): EditorBackupRestorePrecondition | null {
    const manifest = parseEditorDataManifest(value);

    if (manifest) {
        return { manifest };
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    const candidate = value as {
        manifest?: unknown;
        mediaHash?: unknown;
    };
    const nestedManifest = parseEditorDataManifest(candidate.manifest);

    if (!nestedManifest) {
        return null;
    }

    if (
        candidate.mediaHash !== undefined &&
        candidate.mediaHash !== null &&
        typeof candidate.mediaHash !== 'string'
    ) {
        return null;
    }

    return {
        manifest: nestedManifest,
        ...(candidate.mediaHash !== undefined ? { mediaHash: candidate.mediaHash } : {}),
    };
}

export function createRestorePreconditionRequiredResponse(): NextResponse {
    return NextResponse.json(
        {
            message: '恢复前当前数据状态缺失，请刷新页面后重试。',
        },
        { status: 409 }
    );
}

export function createRestoreConflictResponse(error: unknown): NextResponse | null {
    if (!(error instanceof EditorBackupRestoreConflictError)) {
        return null;
    }

    return NextResponse.json(
        {
            message: '当前数据已被其他会话更新，请刷新后重新执行恢复。',
            currentManifest: error.currentManifest,
        },
        { status: 409 }
    );
}
