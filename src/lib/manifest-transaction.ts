import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomically, fsyncDirectory } from '@/lib/atomic-json-writer';
import type {
    EditorDataManifest,
    EditorDataResourceName,
} from '@/lib/editor-data-storage';

const MANIFEST_TRANSACTION_FILE_NAME = '.manifest-transaction.json';
const MANIFEST_TRANSACTION_VERSION = 1;

type ManifestTransactionState = {
    version: typeof MANIFEST_TRANSACTION_VERSION;
    phase: 'prepared' | 'resource-written';
    resource: EditorDataResourceName;
    resourcePath: string;
    manifestPath: string;
    resourceValue: unknown;
    nextManifest: EditorDataManifest;
    updatedAt: string;
};

export class ManifestTransactionIncompleteError extends Error {
    constructor(public readonly statePath: string) {
        super('Manifest transaction is incomplete and must be recovered before reads can continue.');
        this.name = 'ManifestTransactionIncompleteError';
    }
}

function getManifestTransactionStatePath(root: string): string {
    return path.join(root, MANIFEST_TRANSACTION_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseManifestTransactionState(value: unknown): ManifestTransactionState | null {
    if (!isRecord(value)) {
        return null;
    }

    if (
        value.version !== MANIFEST_TRANSACTION_VERSION ||
        (value.phase !== 'prepared' && value.phase !== 'resource-written') ||
        (value.resource !== 'articles' && value.resource !== 'navigation' && value.resource !== 'settings') ||
        typeof value.resourcePath !== 'string' ||
        typeof value.manifestPath !== 'string' ||
        !isRecord(value.nextManifest) ||
        typeof value.updatedAt !== 'string'
    ) {
        return null;
    }

    return value as ManifestTransactionState;
}

function readManifestTransactionState(root: string): ManifestTransactionState | null {
    const statePath = getManifestTransactionStatePath(root);

    if (!fs.existsSync(statePath)) {
        return null;
    }

    return parseManifestTransactionState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
}

function writeManifestTransactionState(root: string, state: ManifestTransactionState): void {
    writeJsonAtomically(getManifestTransactionStatePath(root), state);
}

function removeManifestTransactionState(root: string): void {
    const statePath = getManifestTransactionStatePath(root);

    fs.rmSync(statePath, { force: true });
    fsyncDirectory(root);
}

function readJsonIfExists(filePath: string): unknown | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function isSameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function recoverIncompleteManifestTransaction(root: string): void {
    const statePath = getManifestTransactionStatePath(root);
    const state = readManifestTransactionState(root);

    if (!state) {
        if (fs.existsSync(statePath)) {
            throw new ManifestTransactionIncompleteError(statePath);
        }

        return;
    }

    if (state.phase === 'prepared') {
        removeManifestTransactionState(root);
        return;
    }

    const currentResourceValue = readJsonIfExists(state.resourcePath);

    if (!isSameJsonValue(currentResourceValue, state.resourceValue)) {
        throw new ManifestTransactionIncompleteError(statePath);
    }

    writeJsonAtomically(state.manifestPath, state.nextManifest);
    removeManifestTransactionState(root);
}

export function hasIncompleteManifestTransaction(root: string): boolean {
    return fs.existsSync(getManifestTransactionStatePath(root));
}

export function commitResourceManifestTransaction(input: {
    root: string;
    resource: EditorDataResourceName;
    resourcePath: string;
    manifestPath: string;
    resourceValue: unknown;
    nextManifest: EditorDataManifest;
}): void {
    let resourceWritten = false;

    writeManifestTransactionState(input.root, {
        version: MANIFEST_TRANSACTION_VERSION,
        phase: 'prepared',
        resource: input.resource,
        resourcePath: input.resourcePath,
        manifestPath: input.manifestPath,
        resourceValue: input.resourceValue,
        nextManifest: input.nextManifest,
        updatedAt: new Date().toISOString(),
    });

    try {
        writeJsonAtomically(input.resourcePath, input.resourceValue);
        resourceWritten = true;
        writeManifestTransactionState(input.root, {
            version: MANIFEST_TRANSACTION_VERSION,
            phase: 'resource-written',
            resource: input.resource,
            resourcePath: input.resourcePath,
            manifestPath: input.manifestPath,
            resourceValue: input.resourceValue,
            nextManifest: input.nextManifest,
            updatedAt: new Date().toISOString(),
        });
        writeJsonAtomically(input.manifestPath, input.nextManifest);
        removeManifestTransactionState(input.root);
    } catch (error) {
        if (!resourceWritten) {
            removeManifestTransactionState(input.root);
        }

        throw error;
    }
}
