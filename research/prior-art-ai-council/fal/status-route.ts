// app/api/fal/status/route.ts
// GET /api/fal/status?model={model}&request_id={id}
// Poll the queue status of a fal.ai queued job.

import { NextRequest, NextResponse } from 'next/server';
import { queueStatus } from '@/lib/group/fal';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const model = req.nextUrl.searchParams.get('model');
  const requestId = req.nextUrl.searchParams.get('request_id');

  if (!model || !requestId) {
    return NextResponse.json({ error: 'model and request_id are required' }, { status: 400 });
  }

  try {
    const status = await queueStatus(model, requestId);
    return NextResponse.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
