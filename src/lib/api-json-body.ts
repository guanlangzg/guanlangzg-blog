import { NextRequest, NextResponse } from 'next/server';

export const EDITOR_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const EDITOR_BACKUP_JSON_BODY_LIMIT_BYTES = 128 * 1024 * 1024;
export const EDITOR_SETTINGS_JSON_BODY_LIMIT_BYTES = 256 * 1024;
export const EDITOR_AUTH_JSON_BODY_LIMIT_BYTES = 16 * 1024;

export class JsonBodyTooLargeError extends Error {
    constructor(public readonly limitBytes: number) {
        super(`JSON request body exceeds ${limitBytes} bytes.`);
        this.name = 'JsonBodyTooLargeError';
    }
}

export class JsonBodyParseError extends Error {
    constructor() {
        super('Request body is not valid JSON.');
        this.name = 'JsonBodyParseError';
    }
}

function getContentLength(request: NextRequest): number | null {
    const raw = request.headers.get('content-length');

    if (!raw) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function createJsonBodyTooLargeResponse(): NextResponse {
    return NextResponse.json(
        {
            code: 'body_too_large',
            message: '请求体过大，请缩小数据后重试。',
        },
        { status: 413 }
    );
}

export function createJsonBodyParseErrorResponse(): NextResponse {
    return NextResponse.json(
        {
            code: 'invalid_json',
            message: '请求体不是有效的 JSON。',
        },
        { status: 400 }
    );
}

export async function readJsonBodyWithLimit<T>(
    request: NextRequest,
    limitBytes: number
): Promise<T | null> {
    const contentLength = getContentLength(request);

    if (contentLength !== null && contentLength > limitBytes) {
        throw new JsonBodyTooLargeError(limitBytes);
    }

    const body = request.body;

    if (!body) {
        return null;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        receivedBytes += value.byteLength;

        if (receivedBytes > limitBytes) {
            throw new JsonBodyTooLargeError(limitBytes);
        }

        chunks.push(value);
    }

    const bodyText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');

    if (!bodyText.trim()) {
        return null;
    }

    try {
        return JSON.parse(bodyText) as T;
    } catch {
        throw new JsonBodyParseError();
    }
}
