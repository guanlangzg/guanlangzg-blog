import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';

const AUDIT_LOG_FILE_NAME = 'events.jsonl';
const AUDIT_LOG_VERSION = 1;

export type EditorAuditAction =
    | 'auth.login.success'
    | 'auth.login.failure'
    | 'auth.logout'
    | 'auth.setup.success'
    | 'data.write'
    | 'data.restore'
    | 'r2.settings.update'
    | 'r2.backup.retry'
    | 'media.gc';

export interface EditorAuditEventInput {
    action: EditorAuditAction;
    resource?: string;
    outcome: 'success' | 'failure';
    message?: string;
    metadata?: Record<string, unknown>;
}

export interface EditorAuditEvent extends EditorAuditEventInput {
    version: typeof AUDIT_LOG_VERSION;
    id: string;
    createdAt: string;
}

export function getEditorAuditLogFilePath(): string {
    return path.join(getRuntimeDataRootPath(), 'audit', AUDIT_LOG_FILE_NAME);
}

export function createEditorAuditEvent(input: EditorAuditEventInput): EditorAuditEvent {
    return {
        version: AUDIT_LOG_VERSION,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...input,
    };
}

export function recordEditorAuditEvent(input: EditorAuditEventInput): void {
    const event = createEditorAuditEvent(input);
    const filePath = getEditorAuditLogFilePath();

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
        console.warn('[editor-audit-log] Failed to write audit event:', error);
    }
}
