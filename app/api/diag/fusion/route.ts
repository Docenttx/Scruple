// POST /api/diag/fusion  — DIAGNOSTIC ONLY, no auth.
// Used by the Fusion add-in to emit trace pings during debugging so the
// server log shows which Python handlers are firing on the desktop.
// Remove once the pipeline is proven end-to-end.

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = { raw: 'unparseable body' };
  }
  console.log('[FUS-DIAG]', JSON.stringify(body));
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST JSON here for diag' });
}
