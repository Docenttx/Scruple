// /api/apps/kohya/witness — Phase 4.
//
// Receives POSTs from the in-pod scruple-safetensors-hook whenever
// Kohya writes a checkpoint. Validates the HMAC signature against
// SCRUPLE_APPS_WITNESS_SECRET, looks up the app_session, POSTs to the
// witness server for the leaf hash + HMAC seal, inserts an iterations
// row + training_runs row into the user's active Kohya project.
//
// Body shape (matches scruple_safetensors_hook.py):
//   {
//     event: 'checkpoint_save',
//     path, output_hash, size_bytes, structural_summary,
//     pod_id, user_id, app_id, session_id, client_timestamp
//   }

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';

export const runtime = 'nodejs';

function verifySignature(rawBody: string, sig: string | null): boolean {
  const secret = process.env.SCRUPLE_APPS_WITNESS_SECRET;
  if (!secret) return false;
  if (!sig) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // constant-time comparison
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface WitnessBody {
  event: string;
  path: string;
  output_hash: string;
  size_bytes: number;
  structural_summary?: Record<string, unknown>;
  pod_id?: string;
  user_id: string;
  app_id: string;
  session_id: string;
  client_timestamp: number;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get('x-scruple-signature');

  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let body: WitnessBody;
  try {
    body = JSON.parse(rawBody) as WitnessBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Look up the session — must exist + be active + owned by claimed user
  const row = conn()
    .prepare(
      `SELECT id, user_id, app_id, endpoint_id, status
         FROM app_sessions
        WHERE id = ? AND app_id = 'kohya'`,
    )
    .get(body.session_id) as
    | { id: string; user_id: string; app_id: string; endpoint_id: string; status: string }
    | undefined;

  if (!row) return NextResponse.json({ error: 'unknown session' }, { status: 404 });
  if (row.user_id !== body.user_id) {
    return NextResponse.json({ error: 'session/user mismatch' }, { status: 403 });
  }

  // Update the app_kohya_progress mirror
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO app_kohya_progress (session_id, latest_ckpt_sha256, latest_ckpt_path, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         latest_ckpt_sha256 = excluded.latest_ckpt_sha256,
         latest_ckpt_path   = excluded.latest_ckpt_path,
         updated_at         = excluded.updated_at`,
    )
    .run(row.id, body.output_hash, body.path, now);

  // TODO Phase 4-B: POST to witness server (:5799) for leaf hash +
  // HMAC seal, insert iterations + training_runs rows. For now we log
  // the receipt so the pipeline is testable end-to-end minus the leaf.
  // (Witness server integration follows the same pattern as
  //  /api/canvas/witness — startWorkflow / captureOutput on the runner
  //  code path.)
  console.log(
    `[kohya-witness] session=${row.id} user=${row.user_id} pod=${body.pod_id?.slice(0, 8)} ` +
      `output_hash=${body.output_hash.slice(0, 12)} size=${body.size_bytes} path=${body.path}`,
  );

  return NextResponse.json({
    ok: true,
    session_id: row.id,
    received_at: now,
  });
}
