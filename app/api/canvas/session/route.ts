// GET     /api/canvas/session                  → { active } | { active: null }
// POST    /api/canvas/session  { machine_id? } → { ok, session }
// DELETE  /api/canvas/session                  → { ok, revoked }
//
// Mint, read, and revoke per-user canvas sessions. The session token
// returned here is what the canvas page passes to the Modal-hosted
// ComfyUI iframe (in the URL) and what the canvas's intercept JS
// sends back to /api/canvas/witness/* so we can attribute incoming
// witness events to the right user.
//
// Canvas v2 (WO-2): tier-gating removed. Every signed-in user may mint
// a canvas session. Stripe-card gating + PaymentIntent pre-auth land
// in WO-6 (lifecycle). HTTP+WS proxy as the provenance gate lands in
// WO-4.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import {
  getActiveCanvasSession,
  mintCanvasSession,
  revokeCanvasSession,
} from '@/lib/canvas/session';
import { resolveActiveMachine } from '@/lib/compute/getActiveMachine';
import { getMachineById } from '@/lib/compute/machines';

export const dynamic = 'force-dynamic';

const PostBody = z.object({ machine_id: z.string().min(1).max(64).optional() });

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return unauthorized();
  const active = getActiveCanvasSession(userId);
  return NextResponse.json({
    active: active
      ? {
          id: active.id,
          machine_id: active.machine_id,
          modal_url: active.modal_url,
          started_at: active.started_at,
          last_activity_at: active.last_activity_at,
          expires_at: active.expires_at,
        }
      : null,
  });
}

export async function POST(req: NextRequest) {
  const sess = await auth();
  const userId = (sess?.user as { id?: string } | undefined)?.id;
  if (!userId) return unauthorized();

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Resolve which machine the session targets: explicit body wins,
  // else use the user's Settings → Compute default.
  let machineId: string;
  if (body.machine_id) {
    const m = getMachineById(body.machine_id);
    if (!m) return NextResponse.json({ error: 'Unknown machine_id' }, { status: 400 });
    machineId = m.id;
  } else {
    machineId = resolveActiveMachine(userId).machine.id;
  }

  try {
    const minted = mintCanvasSession(userId, machineId);
    return NextResponse.json({
      ok: true,
      session: {
        id: minted.id,
        machine_id: machineId,
        modal_url: minted.modalUrl,
        expires_at: minted.expiresAt,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Most common: Modal canvas app not yet deployed for this machine.
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function DELETE() {
  const sess = await auth();
  const userId = (sess?.user as { id?: string } | undefined)?.id;
  if (!userId) return unauthorized();
  const active = getActiveCanvasSession(userId);
  if (!active) return NextResponse.json({ ok: true, revoked: false });
  const ok = revokeCanvasSession(active.id, userId);
  return NextResponse.json({ ok: true, revoked: ok, session_id: active.id });
}
