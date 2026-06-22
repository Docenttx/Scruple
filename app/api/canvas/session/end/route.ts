// POST /api/canvas/session/end  { sessionId }
//   → { ok, captured_cents, outcome }
//
// Client posts on explicit End or beforeunload. Server finalizes
// the Stripe PaymentIntent (capture actual cents OR cancel if zero)
// and writes the canvas_session_charges audit row. Idempotent —
// re-finalize is a no-op.
//
// Canvas v2 (WO-6).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { finalizeCanvasCharge } from '@/lib/stripe/canvas';

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
    .prepare(`SELECT user_id FROM canvas_sessions WHERE id = ?`)
    .get(body.sessionId) as { user_id: string } | undefined;
  if (!row || row.user_id !== userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    const result = await finalizeCanvasCharge(body.sessionId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'finalize_failed', detail: message }, { status: 500 });
  }
}
