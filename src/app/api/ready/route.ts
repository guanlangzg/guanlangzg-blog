import { NextResponse } from 'next/server';
import { getReadinessPayload } from '@/lib/health-check';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    const payload = await getReadinessPayload();

    return NextResponse.json(payload, {
        status: payload.status === 'ok' ? 200 : 503,
        headers: {
            'Cache-Control': 'no-store',
        },
    });
}
