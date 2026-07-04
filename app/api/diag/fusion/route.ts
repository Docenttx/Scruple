// POST /api/diag/fusion  — DIAGNOSTIC ONLY, no auth.
// GET  /api/diag/fusion?since=<ms>  — returns ring buffer events after `since`.
//
// The Fusion add-in fires trace pings here during development. In addition
// to logging to the console, the last N events are held in a module-global
// ring buffer so the /embed/fusion/debug page can render them live.

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface DiagEvent {
  ts: number;
  event: string;
  fields: Record<string, unknown>;
}

const RING_SIZE = 2000;

// Module-global ring buffer — survives across requests for the life of the
// Next dev/prod server process. Not shared across cluster workers.
const g = globalThis as unknown as { __scrupleDiagRing?: DiagEvent[] };
if (!g.__scrupleDiagRing) g.__scrupleDiagRing = [];
const ring = g.__scrupleDiagRing;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = { raw: 'unparseable body' };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {}

  const event = typeof body.event === 'string' ? body.event : 'unknown';
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k !== 'event') fields[k] = v;

  ring.push({ ts: Date.now(), event, fields });
  while (ring.length > RING_SIZE) ring.shift();

  console.log('[FUS-DIAG]', JSON.stringify(body));
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const since = Number(new URL(req.url).searchParams.get('since') ?? '0');
  const events = ring.filter((e) => e.ts > since);
  return NextResponse.json({
    ok: true,
    events,
    server_now: Date.now(),
  });
}
