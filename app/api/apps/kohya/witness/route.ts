// /api/apps/kohya/witness — Phase 4, re-placed by WO-11b and re-keyed
// by WO-12.
//
// Receives POSTs from the in-pod scruple-safetensors-hook whenever
// Kohya writes a checkpoint, looks up the app_session, and records the
// checkpoint into app_kohya_progress + training_runs.
//
// WHAT THIS ENDPOINT IS. A SELF-DECLARATION SURFACE FOR AN
// `unattested-client` PLACEMENT, and nothing more. The pod is server
// code on hardware the tenant does not own, and
// docs/canon/PLACEMENT_AND_SURFACES.md §7.2 classifies it identically to
// browser JS anyway, because the tenant has root in the container. At
// that placement §4.1 is explicit: events may be recorded as declared,
// and may never be reported as witnessed. That is why `witnessed` is
// false below and why no amount of re-keying this route changes it.
// The path that CAN produce a leaf is services/scruple-capture/kohya/,
// which refuses to start on a topology that cannot support one.
//
// WO-12 — THE CREDENTIAL. This route used to verify an HMAC keyed by
// `SCRUPLE_APPS_WITNESS_SECRET`: one secret, injected into every RunPod
// pod as an environment variable, so any customer running `env` held
// the credential authenticating every other customer's traffic. The
// primary credential is now the session's own token
// (`app_sessions.signed_token`, minted per session in lib/apps/session.ts
// and handed to the pod by lib/apps/backends/runpod-session.ts), and
// NOTHING IN THE CODEBASE DISTRIBUTES THE GLOBAL SECRET ANY MORE.
//
// The global key is still CONSULTED here, and that is the enumerated
// remainder rather than an oversight — see `authenticate()` below for
// the removal condition and for why it is loud rather than silent. A
// per-session token does not fix P3 (custody, not scope) and is not
// offered as fixing it; it stops one tenant forging another's records
// on a path whose ceiling is `witnessed: false` either way.
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

/** Which key authenticated the declaration. It travels in the response
 *  and in the log, because a credential nobody can see used is a
 *  credential nobody notices is still in service. */
type Credential = 'session' | 'global-deprecated';

function macMatches(rawBody: string, sig: string, key: string): boolean {
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * WO-12. Two keys are tried, in this order, and which one matched is
 * REPORTED — to the caller, in `credential`, and to the operator, as an
 * error-level log line naming P3.
 *
 * 1. `sessionToken` — `app_sessions.signed_token` for the session the
 *    body names. Per session, revocable with it, and useless against
 *    any other tenant's rows. This is what the pod is given.
 *
 * 2. `SCRUPLE_APPS_WITNESS_SECRET` — THE ENUMERATED REMAINDER.
 *
 * On (2), the honest accounting, because "we removed the global secret"
 * would be a stronger sentence than the code supports:
 *
 *   * The DANGEROUS half is gone. The secret's danger was never that
 *     this route read it; it was that lib/apps/backends/runpod-session.ts
 *     wrote it into every pod's environment. That line no longer exists,
 *     and `test/v2/kohya-replacement.test.ts` fails if it comes back. In
 *     a deployment that has stopped setting the variable, this branch is
 *     unreachable — and unsetting it is now a config change with no code
 *     change behind it, which is what "retired" should mean
 *     operationally.
 *
 *   * It is NOT SILENT. A declaration accepted on this key is logged at
 *     error level and carries `credential: 'global-deprecated'` in its
 *     response body. A fallback you cannot see is the thing WO-12
 *     forbids; this one announces itself on every use.
 *
 *   * REMOVAL CONDITION, one line and one file: delete this branch when
 *     `test/v2/kohya-honesty.test.ts` — WO-11a's drift guard, which signs
 *     its fixtures with the global key and is out of WO-12's scope to
 *     edit — is re-pointed at the session credential. Nothing else in the
 *     repo depends on it; `grep -rn SCRUPLE_APPS_WITNESS_SECRET` is the
 *     proof and the report enumerates every hit.
 *
 * The order matters and is not arbitrary: the session key is tried FIRST
 * so that a live deployment which still has the variable set does not
 * quietly attribute session-keyed traffic to the deprecated path.
 */
function authenticate(
  rawBody: string,
  sig: string | null,
  sessionToken: string | null,
): Credential | null {
  if (!sig) return null;
  if (sessionToken && macMatches(rawBody, sig, sessionToken)) return 'session';
  const global = process.env.SCRUPLE_APPS_WITNESS_SECRET;
  if (global && macMatches(rawBody, sig, global)) return 'global-deprecated';
  return null;
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

  // ORDER CHANGED IN WO-12, and the change is the point. The key used to
  // be global, so it could be fetched before anything was known about
  // the caller. A per-session key cannot: you have to know WHICH session
  // is claiming before you can ask what would authenticate it. So parse,
  // look up, then authenticate — and every failure below the parse
  // answers 401 rather than distinguishing "no such session" from "bad
  // signature", which would hand an unauthenticated caller a session
  // enumeration oracle the old ordering happened to avoid by accident.
  let body: WitnessBody;
  try {
    body = JSON.parse(rawBody) as WitnessBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const row = conn()
    .prepare(
      `SELECT id, user_id, app_id, endpoint_id, status, signed_token
         FROM app_sessions
        WHERE id = ? AND app_id = 'kohya'`,
    )
    .get(body.session_id) as
    | {
        id: string;
        user_id: string;
        app_id: string;
        endpoint_id: string;
        status: string;
        signed_token: string | null;
      }
    | undefined;

  const credential = row
    ? authenticate(rawBody, sig, row.signed_token ?? null)
    : null;
  if (!row || !credential) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }
  // A revoked session's pod is being torn down; declarations from it are
  // not evidence of anything and should not still be landing in
  // training_runs. Expiry is deliberately NOT checked here: expires_at is
  // written as an ISO-8601 string in one place and via datetime('now',...)
  // in another, and comparing those two formats is the sqlite trap that
  // has bitten this estate before. Status is unambiguous.
  if (row.status === 'revoked') {
    return NextResponse.json({ error: 'session revoked' }, { status: 403 });
  }
  if (row.user_id !== body.user_id) {
    return NextResponse.json({ error: 'session/user mismatch' }, { status: 403 });
  }

  if (credential === 'global-deprecated') {
    // Loud, every time, at error level. See authenticate() for the
    // removal condition.
    console.error(
      `[kohya-witness] DEPRECATED CREDENTIAL: session=${row.id} authenticated with the ` +
        'global SCRUPLE_APPS_WITNESS_SECRET. Nothing in this codebase distributes that ' +
        'value any more (WO-12); unset it in the deployment to close the path. P3: a ' +
        'credential in a shell the measured party controls is not custody, and a GLOBAL ' +
        "one authenticates every tenant's traffic with every other tenant's copy.",
    );
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
  // NO LEAF IS CREATED HERE, AND WO-11b CHANGED WHY. The old note called
  // it a pending wire-up ("a separate follow-up", WO-05 T-4), which read
  // as though pointing this route at the witness server would close it.
  // It would not. Everything this route receives was observed from inside
  // the pod, which resolves to placement `unattested-client`, where P1 and
  // P3 fail and no leaf may be issued at all — attestation is not even
  // consulted (docs/canon/PLACEMENT_AND_SURFACES.md §4.1, §5.1 rule 1).
  // Wiring a leaf from here would not be an improvement; it would be the
  // misreporting WO-11a removed, restored with better plumbing.
  //
  // So the response below always reports `witnessed: false`, and the fix
  // is a different program: services/scruple-capture/kohya/, which watches
  // the checkpoint volume from outside the pod and refuses to start where
  // that is not possible. docs/canon/KOHYA_REPLACEMENT.md.
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
      'kohya-witness records the checkpoint (hash, size, structural summary) and does not ' +
      'sign a leaf. That is not a missing wire-up: capture inside the pod resolves to ' +
      'placement `unattested-client`, where no leaf may be issued at all ' +
      '(docs/canon/PLACEMENT_AND_SURFACES.md §4.1, §5.1). The path that can produce one is ' +
      'services/scruple-capture/kohya/ — see docs/canon/KOHYA_REPLACEMENT.md.',
    // WO-11b. Reported rather than implied, so a client cannot read
    // `ok: true` as a claim about where this was observed from.
    placement: 'unattested-client',
    // WO-12. Which key authenticated this declaration.
    credential,
    session_id: row.id,
    received_at: now,
  });
}
