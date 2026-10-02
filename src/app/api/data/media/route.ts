import { NextRequest, NextResponse } from 'next/server';
import {
    createEditorDataRootUnavailableResponse,
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import {
    EditorMediaFileTooLargeError,
    EditorMediaInvalidFileError,
    EDITOR_MEDIA_MAX_IMAGE_BYTES,
    storeEditorMediaFile,
} from '@/lib/editor-media-storage';
import { queueCurrentBackupToRemote } from '@/lib/editor-remote-backup';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';

function createInvalidMediaResponse(error: unknown): NextResponse | null {
    if (error instanceof EditorMediaFileTooLargeError) {
        return NextResponse.json(
            {
                code: 'media_too_large',
                message: '图片过大，请压缩后重试。',
                limitBytes: error.limitBytes,
            },
            { status: 413 }
        );
    }

    if (error instanceof EditorMediaInvalidFileError) {
        return NextResponse.json(
            {
                code: 'unsupported_media',
                message: error.message,
            },
            { status: 400 }
        );
    }

    return null;
}

function getUploadedFile(value: FormDataEntryValue | null): File | null {
    if (!value || typeof value === 'string') {
        return null;
    }

    return value;
}

function getContentLength(request: NextRequest): number | null {
    const raw = request.headers.get('content-length');

    if (!raw) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function concatByteChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
}

async function readRequestBodyBytesWithLimit(request: NextRequest): Promise<Uint8Array> {
    const reader = request.body?.getReader();

    if (!reader) {
        return new Uint8Array();
    }

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        receivedBytes += value.byteLength;

        if (receivedBytes > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
            throw new EditorMediaFileTooLargeError();
        }

        chunks.push(value);
    }

    return concatByteChunks(chunks, receivedBytes);
}

async function readUploadedImageBytes(request: NextRequest): Promise<Uint8Array | null> {
    const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
    const contentLength = getContentLength(request);

    if (contentLength !== null && contentLength > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
        throw new EditorMediaFileTooLargeError();
    }

    if (contentType.startsWith('image/')) {
        return readRequestBodyBytesWithLimit(request);
    }

    if (!contentType.startsWith('multipart/form-data')) {
        return null;
    }

    if (contentLength === null) {
        throw new EditorMediaFileTooLargeError();
    }

    const form = await request.formData();
    const file = getUploadedFile(form.get('file'));

    if (!file) {
        return null;
    }

    if (file.size > EDITOR_MEDIA_MAX_IMAGE_BYTES) {
        throw new EditorMediaFileTooLargeError();
    }

    return new Uint8Array(await file.arrayBuffer());
}

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    let bytes: Uint8Array | null;

    try {
        bytes = await readUploadedImageBytes(request);
    } catch (error) {
        const invalidMediaResponse = createInvalidMediaResponse(error);

        if (invalidMediaResponse) {
            return invalidMediaResponse;
        }

        return NextResponse.json(
            {
                message: '图片上传请求格式无效。',
            },
            { status: 400 }
        );
    }

    if (!bytes) {
        return NextResponse.json(
            {
                message: '请选择要上传的图片。',
            },
            { status: 400 }
        );
    }

    try {
        const stored = await withRuntimeDataRootLock(() => storeEditorMediaFile({ bytes }));
        const remoteBackup = await queueCurrentBackupToRemote({
            reason: 'media-write',
            writeSnapshot: false,
        });

        return NextResponse.json({
            success: true,
            asset: stored.asset,
            remoteBackup,
        });
    } catch (error) {
        const unavailableResponse = createEditorDataRootUnavailableResponse(error);

        if (unavailableResponse) {
            return unavailableResponse;
        }

        const invalidMediaResponse = createInvalidMediaResponse(error);

        if (invalidMediaResponse) {
            return invalidMediaResponse;
        }

        throw error;
    }
}
