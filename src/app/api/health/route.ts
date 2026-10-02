import { NextResponse } from 'next/server';
import { getHealthPayload } from '@/lib/health-check';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    const payload = await getHealthPayload();

    return NextResponse.json(payload, {
        status: payload.status === 'ok' ? 200 : 503,
        headers: {
            'Cache-Control': 'no-store',
        },
    });
}
