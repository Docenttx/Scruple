// app/api/fal/result/route.ts
// GET /api/fal/result?model={model}&request_id={id}&project_id={id}
// Fetch the completed result of a queued fal.ai job.
// Downloads output images, hashes them, saves to artifact store, emits witness.

import { NextRequest, NextResponse } from 'next/server';
import { queueResult } from '@/lib/group/fal';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const model = req.nextUrl.searchParams.get('model');
  const requestId = req.nextUrl.searchParams.get('request_id');
  const projectId = req.nextUrl.searchParams.get('project_id')
    || req.headers.get('x-scruple-project-id')
    || 'untracked';
  const sessionId = req.nextUrl.searchParams.get('session_id') || undefined;

  if (!model || !requestId) {
    return NextResponse.json({ error: 'model and request_id are required' }, { status: 400 });
  }

  try {
    const result = await queueResult(model, requestId, projectId, sessionId);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
