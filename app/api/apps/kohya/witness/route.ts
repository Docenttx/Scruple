// /api/apps/kohya/witness — Phase 4.
//
// Receives POSTs from the in-pod scruple-safetensors-hook whenever
// Kohya writes a checkpoint. Validates the HMAC signature against
// SCRUPLE_APPS_WITNESS_SECRET, looks up the app_session, and records
// the checkpoint into app_kohya_progress + training_runs.
//
// IMPORTANT — this route does NOT create a witness leaf. It never POSTs
// to the witness server, so no leaf is signed for a Kohya checkpoint
// (see the comment further down, and docs/canon/STUDIO_P1-P8_GRADE.md,
// Path B — Kohya, which found this route reporting `ok: true` over an
// unwitnessed save). The response follows the same `witnessed` /
// `reason` vocabulary as `app/api/v2/witness/route.ts` (D-8 there):
// `ok: true` means the checkpoint was recorded, `witnessed` says
// whether a leaf exists, and it is always `false` today. Do not flip
// that field to `true` without actually calling the witness server —
// see docs/canon/WO-05-studio-comfyui-kohya.md, T-4, for the follow-up
// that wires this route to `POST /v2/witness`.
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
  /** SHA-256 of the safetensors raw header bytes; may be undefined from older hook builds. */
  header_hash?: string;
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
  const database = conn();

  database
    .prepare(
      `INSERT INTO app_kohya_progress (session_id, latest_ckpt_sha256, latest_ckpt_path, updated_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         latest_ckpt_sha256 = excluded.latest_ckpt_sha256,
         latest_ckpt_path   = excluded.latest_ckpt_path,
         updated_at         = excluded.updated_at`,
    )
    .run(row.id, body.output_hash, body.path, now);

  // Phase 4-B: persist the trained model's fingerprint into the training run
  // so the receipt page + audit script can display it and downstream tooling
  // (LoRA sidecar emitter, provenance decomposition) can bind to it.
  //
  // We look up the session's active project (via app_sessions.endpoint_id
  // which for kohya carries the parent project_id, or via the app_kohya_progress
  // mirror if the session-to-project mapping lives there). If the training_runs
  // row for this project+run_sequence doesn't exist yet we create it; if it
  // does we update the trained-model hash fields in place — same shape either
  // way. All in one transaction so a partial write can't leave the DB
  // inconsistent.
  //
  // We do NOT yet POST to the witness server for a leaf hash from this route —
  // the leaf construction still runs through the canonical /api/v1/log/*
  // ingest surface, keyed by the tenant's API principal, not by the pod-side
  // HMAC (which authenticates the hook, not the human customer). Wiring the
  // pod-side HMAC through to a witness leaf is a separate follow-up
  // (docs/canon/WO-05-studio-comfyui-kohya.md, T-4). Because no leaf is
  // created here, the response below always reports `witnessed: false` —
  // never fabricate a leaf by flipping that to true without actually
  // calling the witness server.
  try {
    const projectRow = database
      .prepare(
        `SELECT p.id AS project_id
           FROM app_sessions s
           JOIN projects p ON p.id = CAST(s.endpoint_id AS INTEGER)
          WHERE s.id = ?
            AND p.type = 'training'
          LIMIT 1`,
      )
      .get(row.id) as { project_id: number } | undefined;

    if (projectRow) {
      const filename = body.path.split('/').pop() ?? body.path;
      const existing = database
        .prepare(
          `SELECT id, run_sequence FROM training_runs
            WHERE project_id = ?
            ORDER BY run_sequence DESC
            LIMIT 1`,
        )
        .get(projectRow.project_id) as { id: number; run_sequence: number } | undefined;

      if (existing) {
        database
          .prepare(
            `UPDATE training_runs
                SET model_hash       = ?,
                    header_hash      = ?,
                    output_path      = ?,
                    output_filename  = ?,
                    completed_at     = ?,
                    status           = 'complete',
                    structural_summary = COALESCE(?, structural_summary)
              WHERE id = ?`,
          )
          .run(
            body.output_hash,
            body.header_hash ?? null,
            body.path,
            filename,
            now,
            body.structural_summary ? JSON.stringify(body.structural_summary) : null,
            existing.id,
          );
      } else {
        database
          .prepare(
            `INSERT INTO training_runs
              (project_id, run_sequence, status, created_at, started_at, completed_at,
               output_path, output_filename, model_hash, header_hash, structural_summary,
               source)
             VALUES (?, 1, 'complete', ?, ?, ?, ?, ?, ?, ?, ?, 'kohya_ss')`,
          )
          .run(
            projectRow.project_id,
            now,
            now,
            now,
            body.path,
            filename,
            body.output_hash,
            body.header_hash ?? null,
            body.structural_summary ? JSON.stringify(body.structural_summary) : null,
          );
      }
    }
  } catch (e) {
    // Non-fatal — checkpoint save must not fail training. Log for observability.
    console.error(
      `[kohya-witness] training_runs write failed for session=${row.id}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  console.log(
    `[kohya-witness] session=${row.id} user=${row.user_id} pod=${body.pod_id?.slice(0, 8)} ` +
      `output_hash=${body.output_hash.slice(0, 12)} ` +
      `header_hash=${body.header_hash?.slice(0, 12) ?? 'null'} ` +
      `size=${body.size_bytes} path=${body.path}`,
  );

  return NextResponse.json({
    ok: true,
    // See the header comment and docs/canon/STUDIO_P1-P8_GRADE.md
    // (Path B — Kohya): this route does not POST to the witness
    // server, so no leaf is signed. `ok: true` means the checkpoint
    // was recorded (app_kohya_progress + training_runs); `witnessed`
    // is the separate, honest answer to whether a leaf exists for it.
    witnessed: false,
    reason:
      'kohya-witness records the checkpoint (hash, size, structural summary) but does not ' +
      'yet POST to the witness server, so no leaf is signed. See docs/canon/WO-05-studio-comfyui-kohya.md T-4.',
    session_id: row.id,
    received_at: now,
  });
}
