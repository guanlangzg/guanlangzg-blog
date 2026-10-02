import { createHash } from 'node:crypto';

function stableJsonValue(value: unknown): string | undefined {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableJsonValue(item) ?? 'null').join(',')}]`;
    }

    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
            .sort()
            .map((key) => {
                const serialized = stableJsonValue(record[key]);

                return serialized === undefined ? null : `${JSON.stringify(key)}:${serialized}`;
            })
            .filter((entry): entry is string => entry !== null);

        return `{${entries.join(',')}}`;
    }

    return JSON.stringify(value);
}

export function stableJsonStringify(value: unknown): string {
    return stableJsonValue(value) ?? 'null';
}

export function sha256Hex(value: string | Uint8Array): string {
    return createHash('sha256')
        .update(value)
        .digest('hex');
}
