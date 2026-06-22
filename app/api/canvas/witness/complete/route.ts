// POST /api/canvas/witness/complete
//   { session_token, prompt_id,
//     output_bytes_b64, output_content_type, output_kind?,
//     output_filename?, gpu? }
//   → { ok, iteration_id, leaf_hash, run_sequence }
//
// Fired by the canvas page's intercept JS when ComfyUI's WS
// `execution_success` event lands (workflow finished). The intercept
// fetches the output file from ComfyUI's /view endpoint and ships
// the bytes here. We pair with the pending row from /start, then
// run the standard ingestIteration pipeline — same hashing, witness
// signature, machine_id provenance as everything else in scruple-web.
//
// See docs/wo/2026-06-22-canvas-on-modal.md.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { touchCanvasSession, verifyCanvasToken } from '@/lib/canvas/session';
import { ingestIteration } from '@/lib/iterations/ingest';

export const dynamic = 'force-dynamic';

const Body = z.object({
  session_token: z.string().min(1),
  prompt_id: z.string().min(1),
  output_bytes_b64: z.string().min(1),
  output_content_type: z.string().min(1),
  output_kind: z.enum(['image', 'video', 'checkpoint']).optional(),
  output_filename: z.string().optional().nullable(),
  gpu: z.string().optional(),
});

interface PendingRow {
  prompt_id: string;
  session_id: string;
  user_id: string;
  project_id: number;
  workflow_api_json: string;
  status: 'pending' | 'done' | 'lost';
}

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

  // Look up the pending row written by /start. If absent — either the
  // intercept missed the queue submission, or this is a /complete
  // without a paired /start. We still ingest (we have the bytes), but
  // we mark provenance as "best effort" via a sentinel project_id.
  const pending = conn()
    .prepare(
      `SELECT * FROM canvas_pending_iterations
        WHERE session_id = ? AND prompt_id = ?`,
    )
    .get(verified.sessionId, body.prompt_id) as PendingRow | undefined;

  if (!pending) {
    return NextResponse.json(
      { error: 'No matching pending iteration; queue first or set project_id' },
      { status: 404 },
    );
  }

  touchCanvasSession(verified.sessionId);

  let workflow: Record<string, unknown> = {};
  try {
    workflow = JSON.parse(pending.workflow_api_json);
  } catch { /* keep empty */ }

  const imageBytes = Buffer.from(body.output_bytes_b64, 'base64');

  try {
    const { iteration, leafHash, runSequence } = await ingestIteration({
      userId: verified.userId,
      projectId: pending.project_id,
      provider: 'comfydeploy',
      providerJobId: body.prompt_id,
      prompt: '(canvas workflow / modal canvas)',
      spec: {
        prompt: '(canvas workflow)',
        providerExtras: { workflowApiJson: workflow },
      },
      imageBytes,
      imageContentType: body.output_content_type,
      imageFilename: body.output_filename ?? null,
      outputKind: body.output_kind ?? 'image',
      executionBackend: 'modal-test',
      executionAttestation: null,
      computeMachineId: verified.machineId,
    });

    conn()
      .prepare(
        `UPDATE canvas_pending_iterations SET status = 'done' WHERE session_id = ? AND prompt_id = ?`,
      )
      .run(verified.sessionId, body.prompt_id);

    return NextResponse.json({
      ok: true,
      iteration_id: iteration.id,
      leaf_hash: leafHash,
      run_sequence: runSequence,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'ingest_failed', detail: message }, { status: 500 });
  }
}
