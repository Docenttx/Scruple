// POST /api/apps/kohya/jobs — the tenant-facing training surface — WO-19.
//
// ---------------------------------------------------------------------------
// THE ROUTE THAT REPLACES A SHELL
// ---------------------------------------------------------------------------
//
// Studio's Kohya has, until now, offered training by handing the tenant
// Gradio on port 7860. Gradio is not a form: `kohya_gui/lora_gui.py` builds an
// `accelerate launch …` argv and runs it through `subprocess.Popen`, and
// `common_gui.py::run_cmd_advanced_training` appends whatever the tenant typed
// into the GUI's `additional_parameters` box to that argv. That box is a
// general injection point for `--network_module`, `--dataset_class` and
// `--optimizer_type` — three import paths — and it ships in the image today
// (lib/apps/kohya/arguments.ts, GUI_ARBITRARY_ARGUMENT_FIELD).
//
// So the tenant has code execution in that container, and therefore the
// placement is `unattested-client`, and therefore no leaf may be issued for
// anything observed inside it. That is not RunPod's doing — RunPod gives the
// customer no console, no SSH and no exec, because the pod runs under our API
// key. We granted it, by choosing what to expose.
//
// This route is the other choice. It accepts DATA AND HYPERPARAMETERS AND
// NOTHING ELSE, denies by default, and cannot express a command — there is no
// field in the schema that is a free string, so there is nowhere to write one.
// The whitelist, the classification it is checked against, and the derivation
// that turns both into a placement live in lib/apps/kohya/.
//
// ---------------------------------------------------------------------------
// WHAT THIS ROUTE DOES NOT DO, STATED HERE SO IT IS NOT INFERRED
// ---------------------------------------------------------------------------
//
// IT DOES NOT WITNESS ANYTHING. Accepting a job is not observing an artifact.
// The response carries `witnessed: false` with a reason, exactly as
// /api/apps/kohya/witness does and for a related but distinct cause: there
// the answer is "no leaf may be issued at that placement", here it is "no
// checkpoint exists yet". A leaf is produced by the component watching the
// checkpoint volume (services/scruple-capture/kohya/job-runner.ts), never by
// an HTTP route that took a form.
//
// D-8 and PLACEMENT_AND_SURFACES.md §4.1 are the standing rule and this route
// is inside it: `ok: true` means the job was accepted and recorded. Nothing
// here may ever report a checkpoint as witnessed unless a leaf exists, and
// test/v2/kohya-jobapi.test.ts scans this file for the attempt.
//
// ---------------------------------------------------------------------------
// THE CREDENTIAL
// ---------------------------------------------------------------------------
//
// HMAC over the raw body keyed by the app session's `signed_token`, which is
// the same credential /api/apps/kohya/witness uses after WO-12 and is already
// held by this user's browser. Deliberately NOT the deprecated global
// `SCRUPLE_APPS_WITNESS_SECRET`: that key exists in the witness route as an
// enumerated remainder with a removal condition, and a NEW route accepting it
// would reset that clock.
//
// Note what the credential is and is not. It authenticates WHOSE session is
// submitting; it is not custody (P3 is about custody, not scope) and it is not
// what makes the placement hold. The placement holds because of what the
// schema cannot express, which is a property of the code and not of the caller.

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';

import { conn } from '@/lib/db/sqlite';
import {
  canonicalJobJson,
  jobSpecHash,
  validateJobSpec,
  type ValidatedJobSpec,
} from '@/lib/apps/kohya/job-spec';
import { studioJobApiAssurance } from '@/lib/apps/kohya/placement';
import { kohyaSurfaceMode } from '@/lib/apps/runpod-machines';

export const runtime = 'nodejs';

/** How long we wait for the pod's job API to accept. Short: the component
 *  answers 202 as soon as it has spawned, and a long hang here would turn a
 *  dead pod into a dead request. */
const DISPATCH_TIMEOUT_MS = 15_000;

/** What happened when we tried to hand the job to the container — WO-30.
 *
 *  REPORTED, NEVER INFERRED. Before this existed, `POST /jobs` recorded a row
 *  and returned `ok: true`, and nothing anywhere forwarded the job to the pod:
 *  the surface the whole `server-library` argument rests on had no caller and
 *  the accepted job went nowhere. A caller that cannot tell "recorded" from
 *  "running" is the same class of defect as one that cannot tell "recorded"
 *  from "witnessed" (D-8), so it gets the same treatment — a field, a reason,
 *  and no optimistic default. */
interface DispatchOutcome {
  attempted: boolean;
  ok: boolean;
  status: number | null;
  reason: string;
}

/**
 * Forward the validated spec to the component inside the pod.
 *
 * THE SPEC IS RE-SENT, NOT THE REQUEST. The container validates with the same
 * module this route does (`services/scruple-capture/kohya/job-api-server.ts`
 * imports `lib/apps/kohya/job-spec.ts`), so what crosses is the CANONICAL spec
 * — the same bytes `params_hash` covers and the same bytes the checkpoint's
 * leaf commits to. Proxying the tenant's raw body instead would let the row and
 * the run disagree about what was asked for.
 */
async function dispatchToPod(
  endpointUrl: string,
  spec: ValidatedJobSpec,
): Promise<DispatchOutcome> {
  const base = endpointUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The container's endpoint takes the bare spec — it has no session
      // envelope, because inside the pod there is exactly one session.
      body: canonicalJobJson(spec),
      signal: controller.signal,
    });
    const ok = res.status === 202 || res.status === 200;
    return {
      attempted: true,
      ok,
      status: res.status,
      reason: ok
        ? 'The component accepted the job and started the trainer as its child. A checkpoint ' +
          'becomes witnessed when the component observes it close on the output volume.'
        : `The component refused the job (${res.status}). The row stays 'queued': a job that ` +
          'was recorded and not started must not read as one that is running.',
    };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      status: null,
      reason:
        `Could not reach the component in the pod (${String(e)}). The job is RECORDED and NOT ` +
        'STARTED. It is left queued rather than retried here — a retry loop inside a request ' +
        'handler is how one unreachable pod becomes a stuck route.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function macMatches(rawBody: string, sig: string, key: string): boolean {
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface JobBody {
  session_id?: string;
  /** The job. Every other top-level key is refused, so a client cannot smuggle
   *  a parameter past the validator by putting it beside `spec`. */
  spec?: unknown;
}

/** Columns training_runs already has that map onto whitelisted parameters, so
 *  the run row is queryable without a migration. `config_json` carries the
 *  canonical spec in full; these are a denormalised index over it. */
function trainingRunColumns(spec: ValidatedJobSpec) {
  const num = (k: string) => (typeof spec[k] === 'number' ? (spec[k] as number) : null);
  const str = (k: string) => (typeof spec[k] === 'string' ? (spec[k] as string) : null);
  return {
    network_dim: num('network_dim'),
    network_alpha: num('network_alpha'),
    learning_rate: num('learning_rate'),
    lr_scheduler: str('lr_scheduler'),
    lr_warmup_steps: num('lr_warmup_steps'),
    optimizer_type: str('optimizer'),
    max_train_epochs: num('max_train_epochs'),
    train_batch_size: num('train_batch_size'),
    resolution: str('resolution'),
    mixed_precision: str('mixed_precision'),
    save_precision: str('save_precision'),
    output_filename: str('output_name'),
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get('x-scruple-signature');

  let body: JobBody;
  try {
    body = JSON.parse(rawBody) as JobBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Parse, look up, then authenticate — the WO-12 ordering. A per-session key
  // cannot be fetched before you know which session is claiming, and every
  // failure below the parse answers 401 so that an unauthenticated caller is
  // not handed a session-enumeration oracle.
  const row = conn()
    .prepare(
      `SELECT id, user_id, endpoint_id, endpoint_url, status, signed_token
         FROM app_sessions
        WHERE id = ? AND app_id = 'kohya'`,
    )
    .get(body.session_id ?? '') as
    | {
        id: string;
        user_id: string;
        endpoint_id: string;
        endpoint_url: string | null;
        status: string;
        signed_token: string | null;
      }
    | undefined;

  const authenticated =
    !!row && !!sig && !!row.signed_token && macMatches(rawBody, sig, row.signed_token);
  if (!authenticated || !row) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }
  if (row.status === 'revoked') {
    return NextResponse.json({ error: 'session revoked' }, { status: 403 });
  }

  // Top-level shape. Refused before the spec is looked at, because a client
  // who put `args` next to `spec` rather than inside it deserves the same
  // answer, and because silently ignoring unknown envelope keys is how a
  // second parameter channel gets discovered later.
  const envelopeExtras = Object.keys(body).filter((k) => k !== 'session_id' && k !== 'spec');
  if (envelopeExtras.length) {
    return NextResponse.json(
      {
        error: 'unexpected fields',
        fields: envelopeExtras,
        reason:
          'The request envelope is exactly { session_id, spec }. A parameter beside `spec` is ' +
          'a second channel into the trainer and is refused for the same reason a parameter ' +
          'inside it would be (docs/canon/KOHYA_REPLACEMENT.md §8).',
      },
      { status: 400 },
    );
  }

  const result = validateJobSpec(body.spec);
  if (!result.ok) {
    // 400 with EVERY refusal, not the first: a client fixing their request
    // should not have to discover the whitelist one status code at a time,
    // and the enumerated denials are the documentation.
    return NextResponse.json(
      {
        error: 'job refused',
        refusals: result.refusals,
        reason:
          'The training job API accepts data and hyperparameters, never a command, and denies ' +
          'by default. An argument that cannot be classified is denied.',
      },
      { status: 400 },
    );
  }

  const spec = result.spec;
  const assurance = studioJobApiAssurance();
  const specHash = jobSpecHash(spec);
  const jobId = `kj_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  // Recorded through the schema that already exists. `config_json` holds the
  // canonical spec — the same bytes `params_hash` covers and the same bytes
  // the component commits to in the checkpoint's run context — so the leaf and
  // the row agree by construction rather than by convention.
  let runId: number | null = null;
  try {
    const projectRow = conn()
      .prepare(
        `SELECT p.id AS project_id
           FROM app_sessions s
           JOIN projects p ON p.id = CAST(s.endpoint_id AS INTEGER)
          WHERE s.id = ? AND p.type = 'training'
          LIMIT 1`,
      )
      .get(row.id) as { project_id: number } | undefined;

    if (projectRow) {
      const cols = trainingRunColumns(spec);
      const seq =
        ((
          conn()
            .prepare(`SELECT MAX(run_sequence) AS m FROM training_runs WHERE project_id = ?`)
            .get(projectRow.project_id) as { m: number | null }
        ).m ?? 0) + 1;

      const info = conn()
        .prepare(
          `INSERT INTO training_runs
             (project_id, run_sequence, status, created_at, source,
              params_hash, config_json,
              network_dim, network_alpha, learning_rate, lr_scheduler, lr_warmup_steps,
              optimizer_type, max_train_epochs, train_batch_size, resolution,
              mixed_precision, save_precision, output_filename)
           VALUES (?, ?, 'queued', ?, 'kohya_ss', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectRow.project_id,
          seq,
          now,
          specHash,
          canonicalJobJson(spec),
          cols.network_dim,
          cols.network_alpha,
          cols.learning_rate,
          cols.lr_scheduler,
          cols.lr_warmup_steps,
          cols.optimizer_type,
          cols.max_train_epochs,
          cols.train_batch_size,
          cols.resolution,
          cols.mixed_precision,
          cols.save_precision,
          cols.output_filename,
        );
      runId = info.lastInsertRowid as number;
    }
  } catch (e) {
    // A recording failure must not be reported as an accepted job — unlike the
    // witness route, where the row is a mirror of an event that already
    // happened, here the row IS the job. Fail loudly.
    console.error(`[kohya-jobs] training_runs insert failed for session=${row.id}: ${String(e)}`);
    return NextResponse.json({ error: 'could not record job' }, { status: 500 });
  }

  // ---- hand it to the component -------------------------------------
  //
  // ONLY IN `job-api` MODE, and the asymmetry is the tier. A `gui` pod exposes
  // Kohya's Gradio launcher on 3001 and has no component in it to accept a
  // job; POSTing to it would 404 at best and, at worst, reach something that
  // is not ours. The surface mode is read from the same function
  // `runpod-session.ts` used to CHOOSE the image, so the route cannot decide
  // to dispatch to a container that was never built for it.
  const mode = kohyaSurfaceMode();
  let dispatch: DispatchOutcome = {
    attempted: false,
    ok: false,
    status: null,
    reason:
      mode === 'job-api'
        ? 'This session has no endpoint URL, so there is nowhere to send the job. It is ' +
          'recorded and queued.'
        : "SCRUPLE_KOHYA_SURFACE is 'gui', so this pod runs Kohya's Gradio launcher and has no " +
          'component in it to accept a job. The job is RECORDED ONLY. Nothing produced by that ' +
          'pod can be witnessed either — the placement is `unattested-client` ' +
          '(docs/canon/PLACEMENT_AND_SURFACES.md §4.1).',
  };
  if (mode === 'job-api' && row.endpoint_url) {
    dispatch = await dispatchToPod(row.endpoint_url, spec);
    if (dispatch.ok && runId !== null) {
      // 'running' ONLY on a 202 that actually came back. A status written
      // optimistically beside a request that may not have landed is the same
      // class of lie as claiming a leaf that does not exist (D-8).
      conn()
        .prepare(`UPDATE training_runs SET status = 'running', started_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
    }
  }

  return NextResponse.json({
    ok: true,
    job_id: jobId,
    run_id: runId,
    spec_hash: specHash,
    // Whether the job reached the trainer, as distinct from whether it was
    // accepted and recorded. `ok: true` has always meant the latter.
    dispatch,
    surface: mode,
    // The tier, reported rather than implied, and DERIVED rather than declared
    // — lib/apps/kohya/placement.ts computes it from the whitelist and the
    // classification table every time this route is called.
    placement: assurance.placement,
    leaf: assurance.leaf,
    p1: assurance.p1,
    p3: assurance.p3,
    // Not yet, and not by this route ever. A checkpoint becomes witnessed when
    // the component observes it close on the volume and a leaf is issued.
    witnessed: false,
    reason:
      'The job is accepted and recorded. `witnessed` is false because no checkpoint exists ' +
      'yet: a leaf is produced by the capture component watching the checkpoint volume ' +
      '(services/scruple-capture/kohya/job-runner.ts), never by the route that accepted the ' +
      'job. See docs/canon/KOHYA_REPLACEMENT.md §7.',
    // The two obligations no code in this process can check. Named in the
    // response so an integrator reading a receipt knows which half of the tier
    // is evidence and which half is still a claim awaiting H-4 §7 probes.
    needs_probe: assurance.needsProbe,
    session_id: row.id,
    accepted_at: now,
  });
}
