// POST /api/canvas/session/heartbeat  { sessionId }
//   → { ok, accumulated_seconds } | 404 if no active session
//
// Client posts every ~30s while the canvas iframe is alive. Server
// updates `last_heartbeat` and ticks `accumulated_seconds` by the
// delta since the last heartbeat (capped at 120s to bound runaway
// accumulation on browser sleep/wake). Reaper script picks up
// sessions where last_heartbeat is stale.
//
// Canvas v2 (WO-6).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { heartbeatCanvasSession } from '@/lib/stripe/canvas';

export const dynamic = 'force-dynamic';

const Body = z.object({ sessionId: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const row = conn()
    .prepare(`SELECT user_id, status FROM canvas_sessions WHERE id = ?`)
    .get(body.sessionId) as { user_id: string; status: string } | undefined;
  if (!row || row.user_id !== userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (row.status !== 'active') {
    return NextResponse.json({ error: 'Session not active' }, { status: 409 });
  }

  const result = heartbeatCanvasSession(body.sessionId);
  if (!result) return NextResponse.json({ error: 'Session finalized' }, { status: 409 });
  return NextResponse.json({ ok: true, ...result });
}
