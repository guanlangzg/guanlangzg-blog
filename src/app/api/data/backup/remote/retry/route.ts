import { NextRequest } from 'next/server';
import {
    ensureEditorWriteRequest,
} from '@/lib/editor-api-auth';
import { recordEditorAuditEvent } from '@/lib/editor-audit-log';
import { createRemoteBackupRetryFailedResponse } from '../actions';

export async function POST(request: NextRequest) {
    const authError = await ensureEditorWriteRequest(request);

    if (authError) {
        return authError;
    }

    const response = await createRemoteBackupRetryFailedResponse();

    recordEditorAuditEvent({
        action: 'r2.backup.retry',
        resource: 'cloudflare-r2',
        outcome: response.ok ? 'success' : 'failure',
    });

    return response;
}
