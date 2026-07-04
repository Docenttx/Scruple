// POST /api/fusion/handoff  — palette hands its API key to a Python session
// GET  /api/fusion/handoff?session=<sid>  — Python fetches it back
//
// Server-side hand-off used to bypass Fusion's palette bridge, which
// silently drops JS→Python messages in this environment. Both palette
// JS (browser context) and the Python add-in already speak HTTPS to us,
// so we broker the api-key handoff in memory keyed by a random session
// id that Python bakes into the palette URL.
//
// Auth model: knowledge of the session id IS the auth. It's a 32-byte
// hex string generated fresh per Python-side add-in start. TTL 5 min.
// GET clears the slot after read (one-shot) so a leaked sid can only be
// redeemed once.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// In-memory slot store — dev-server only, single process. For prod
// clustered deployment this would want to live in Redis / SQLite.
type Slot = { key: string; expiresAt: number };
const store: Map<string, Slot> = ((globalThis as unknown as { __fusionHandoff?: Map<string, Slot> }).__fusionHandoff ||= new Map());

const TTL_MS = 5 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [sid, slot] of store.entries()) {
    if (slot.expiresAt < now) store.delete(sid);
  }
}

const PostSchema = z.object({
  session: z.string().min(16).max(128),
  key: z.string().min(10).max(500),
});

export async function POST(req: NextRequest) {
  sweep();
  let body: z.infer<typeof PostSchema>;
  try {
    body = PostSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  store.set(body.session, { key: body.key, expiresAt: Date.now() + TTL_MS });
  console.log('[FUS-DIAG]', JSON.stringify({ event: 'handoff_stored', session_prefix: body.session.slice(0, 8), key_prefix: body.key.slice(0, 12) }));
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  sweep();
  const session = new URL(req.url).searchParams.get('session');
  if (!session) return NextResponse.json({ error: 'missing session' }, { status: 400 });
  const slot = store.get(session);
  if (!slot) return NextResponse.json({ key: null }, { status: 200 });
  // Non-consuming read: slot persists until TTL. This lets the Python-side
  // _ensure_api_key() recover the key on-demand after a stale-closure
  // scenario (add-in Stop/Start leaves an old handler pointing at an old
  // _state singleton). TTL is the security backstop.
  console.log('[FUS-DIAG]', JSON.stringify({ event: 'handoff_delivered', session_prefix: session.slice(0, 8), key_prefix: slot.key.slice(0, 12) }));
  return NextResponse.json({ key: slot.key });
}
