// POST /api/canvas/witness/start
//   { session_token, project_id, prompt_id, workflow_api_json }
//   → { ok }
//
// Fired by the canvas page's intercept JS the moment ComfyUI's
// /prompt is invoked (i.e., the user hit Queue). Records the
// workflow JSON so we have the inputs captured even if the
// container crashes before /complete fires. The corresponding
// /api/canvas/witness/complete then provides the output bytes.
//
// Token is required and HMAC-verified server-side; the canvas iframe
// is untrusted with respect to who-is-this-user.
//
// See docs/wo/2026-06-22-canvas-on-modal.md.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { touchCanvasSession, verifyCanvasToken } from '@/lib/canvas/session';

export const dynamic = 'force-dynamic';

const Body = z.object({
  session_token: z.string().min(1),
  project_id: z.number().int().positive(),
  prompt_id: z.string().min(1),
  workflow_api_json: z.record(z.unknown()),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  const verified = verifyCanvasToken(body.session_token);
  if (!verified) {
    return NextResponse.json({ error: 'Invalid or expired session token' }, { status: 401 });
  }
  touchCanvasSession(verified.sessionId);

  // INSERT OR REPLACE so re-tries from the canvas (e.g., page reload
  // mid-queue) overwrite the JSON without duplicating rows.
  conn()
    .prepare(
      `INSERT OR REPLACE INTO canvas_pending_iterations
         (prompt_id, session_id, user_id, project_id, workflow_api_json, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      body.prompt_id,
      verified.sessionId,
      verified.userId,
      body.project_id,
      JSON.stringify(body.workflow_api_json),
    );
  return NextResponse.json({ ok: true });
}
