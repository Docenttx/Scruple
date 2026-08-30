// POST /api/v2/witness — witness one event.
//
// Supersedes /api/witness/cad, /api/scruple/witness/{adobe,photoshop} and
// /api/apps/kohya/witness. Those four were the same operation expressed
// four ways, on three different auth models, with three different ideas
// of what a successful response means.
//
// TWO THINGS THIS ROUTE DOES THAT NONE OF THEM DID:
//
// 1. It requires a baseline (D-3). §3 says every workflow leaf references
//    the baseline; §5 calls a leaf from unbaselined code NOT
//    Scruple-witnessed. A leaf with no baseline_ref is therefore not a
//    weaker leaf, it is a different thing, and accepting it would make
//    "Scruple-witnessed" mean nothing in particular.
//
// 2. It always reports `witnessed` (D-8). Capture stays non-blocking —
//    that is a deliberate design choice and it survives — but the caller
//    is told the truth either way. The old ingest path returned ok:true
//    over a failed witness with no field to express it, while the Adobe
//    routes wrote witnessed=1 unconditionally.
//
// 3. It carries the whole evidence package (WO-1). It did not always.
//    The first cut accepted `graph` and discarded it — literally
//    `workflowHash: body.graph ? undefined : undefined` — and never
//    computed input_hash or model_fingerprints_hash at all. That made
//    this route WORSE evidence than the legacy canvas path it was
//    written to replace, which has carried all five hashes since v2.2.
//    The formulas now live in lib/leaf/hashes.ts and both paths import
//    them, because two implementations of a preimage are two preimages.
//    Every field is defined in lib/leaf/registry.yaml and
//    test/v2/leaf-registry.test.ts fails if this file emits one that
//    is not, or drops one that must be.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { witness } from '@/lib/scruple/witness';
import {
  hashGraphOrTraining,
  hashModelFingerprints,
  hashRunInputs,
} from '@/lib/leaf/hashes';

export const dynamic = 'force-dynamic';

const Body = z.object({
  baseline_ref: z.string().regex(/^[0-9a-f]{64}$/, 'must be the 64-hex tamper_surface_hash'),
  kind: z.enum(['document_save', 'artifact', 'graph_execute', 'model_write']),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(1),
  project_id: z.number().int().positive().optional(),
  graph: z.record(z.unknown()).optional(),
  training: z.record(z.unknown()).optional(),
  machine_manifest_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // ---- the input side of the package (WO-1) ------------------------
  // Two ways in, because this surface is zero-content (P6) and the only
  // party holding input bytes is the caller.
  //
  //  `inputs`     — a declared manifest of {kind, hash}. We hash it with
  //                 the same function ingest.ts uses, so the preimage is
  //                 identical rather than merely similar.
  //  `input_hash` — already computed host-side. Passed through verbatim.
  //
  // Same shape for the weights. A caller may send the fingerprint
  // manifest and let us hash it, or send the hash alone.
  inputs: z
    .array(
      z.object({
        kind: z.string().min(1),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .optional(),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  model_fingerprints: z.record(z.record(z.unknown())).optional(),
  model_fingerprints_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  attestation: z.object({ type: z.string().min(1), report: z.string().min(1) }).optional(),
  continuity: z
    .object({
      produced_at: z.string().min(1),
      external_manifest_hash: z.string().min(1),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'witness:write');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return v2Error(
      'invalid_body',
      'Witness request did not validate. Note `mime` is required and must be declared by the caller — it is never inferred here.',
      String(e),
    );
  }

  // ---- D-3: baseline or refuse -------------------------------------
  const base = conn()
    .prepare(
      `SELECT baseline_hash, retired_at FROM baselines
        WHERE tenant_id = ? AND baseline_hash = ?`,
    )
    .get(principal.userId, body.baseline_ref) as
    | { baseline_hash: string; retired_at: string | null }
    | undefined;

  if (!base) {
    return v2Error(
      'baseline_required',
      'This baseline is not known for this tenant. Establish one with POST /api/v2/baseline before witnessing — an event from unbaselined code is not Scruple-witnessed (§3, §5).',
    );
  }
  if (base.retired_at !== null) {
    return v2Error(
      'baseline_stale',
      'This baseline has been retired by a later transition. Re-read GET /api/v2/baseline/current and retry — leaves must reference the active baseline (§4).',
    );
  }

  // ---- §12.4: verified or passthrough, never bare -------------------
  // Chain-to-vendor-root verification is not implemented; all six
  // verifier plugins are structural-only. Anything supplied is therefore
  // recorded honestly as passthrough. "Stored" must not read as
  // "verified".
  const attestationStatus: 'verified' | 'passthrough' | null = body.attestation
    ? 'passthrough'
    : null;

  // ---- resolve the project BEFORE witnessing ------------------------
  //
  // Order matters here and it did not used to. The witness call ran
  // first, with `projectId: `tenant:${userId}`` and `runSequence: 0`
  // hardcoded, and the INSERT afterwards used a DIFFERENT project id and
  // a properly computed sequence. Three consequences, none visible from
  // this file:
  //
  //  - Every leaf this route ever produced claimed run_sequence 0. The
  //    witness chains prev_record_hash by `ORDER BY run_sequence DESC`,
  //    so a second event could not be ordered against the first.
  //  - `tenant:` is on the production witness's refused-prefix list
  //    (server.js:~554), added after a test wrote nine rows into the
  //    real audit log. So in production this route's witness call
  //    returned 400 and the catch below swallowed it: `witnessed` was
  //    false for every event that did not carry an explicit project_id,
  //    and nothing said why.
  //  - The leaf and the row it was stored on disagreed about which
  //    project they belonged to.
  //
  // Resolving the project first fixes all three, and drops the synthetic
  // id entirely: the witness now sees the same numeric project id the
  // canvas path sends, so a tenant's plugin events and their canvas
  // events land on one chain instead of two.
  const now = new Date().toISOString();

  // `iterations` is project-scoped — the table predates the canon surface,
  // which is tenant-scoped. Rather than push project management into every
  // adapter (the §4 hook contract goes attach -> baseline -> save ->
  // witness, with no project step), resolve or create one per tenant and
  // host. Found live: without this the route 500s on a NOT NULL
  // constraint, which no unit test could have caught.
  let projectId = body.project_id ?? null;
  if (projectId === null) {
    const holderName = `scruple:${body.kind === 'model_write' ? 'training' : 'workflow'}`;
    const existing = conn()
      .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ? LIMIT 1`)
      .get(principal.userId, holderName) as { id: number } | undefined;
    if (existing) {
      projectId = existing.id;
    } else {
      const created = conn()
        .prepare(
          `INSERT INTO projects
             (user_id, name, type, status, created_at,
              iteration_count, is_active, witnessed_count, is_archived)
           VALUES (?, ?, 'image', 'unlocked', ?, 0, 0, 0, 0)`,
        )
        .run(principal.userId, holderName, now);
      projectId = Number(created.lastInsertRowid);
    }
  }

  // run_sequence was hardcoded to 0, which collided with the UNIQUE
  // (project_id, run_sequence) index on the SECOND witness for any tenant.
  // The first call always worked, so nothing short of witnessing twice
  // would have found it — which is precisely what a unit test with a
  // mocked database does not do.
  const seqRow = conn()
    .prepare(`SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next FROM iterations WHERE project_id = ?`)
    .get(projectId) as { next: number };
  const runSequence = seqRow?.next ?? 1;

  // ---- the evidence package (WO-1) ----------------------------------
  // Every hash below is defined in lib/leaf/registry.yaml, including the
  // exact preimage, and computed by lib/leaf/hashes.ts — the same module
  // lib/iterations/ingest.ts calls. Reimplementing any of them here
  // would produce a second preimage that looks like the first until an
  // auditor tries to reproduce one.

  // workflow_hash. On kind=model_write there is no graph and the
  // training recipe plays the graph's role; `kind` tells a verifier
  // which document to re-canonicalize. Before WO-1 both were accepted
  // and silently dropped.
  const workflowHash = hashGraphOrTraining(body.graph, body.training);

  // input_hash. This surface never sees input bytes (P6), so either the
  // caller declares the manifest and we hash it with ingest's formula,
  // or the caller sends the hash it computed itself.
  const inputHash =
    body.input_hash ??
    (body.inputs
      ? hashRunInputs({ provider: null, prompt: null, spec: null, inputs: body.inputs })
      : null);

  // model_fingerprints_hash. Same two ways in.
  const fingerprints = hashModelFingerprints(body.model_fingerprints);
  if (
    fingerprints &&
    body.model_fingerprints_hash &&
    fingerprints.hash !== body.model_fingerprints_hash
  ) {
    // Refuse rather than pick one. A caller that sent both is asserting
    // they agree, and if they do not, one of the two is wrong — choosing
    // silently would put a hash in the leaf that does not describe the
    // manifest stored beside it.
    return v2Error(
      'invalid_body',
      'model_fingerprints and model_fingerprints_hash disagree. Send one or the other, or send a hash that matches the manifest.',
      { computed: fingerprints.hash, supplied: body.model_fingerprints_hash },
    );
  }
  const modelFingerprintsHash = body.model_fingerprints_hash ?? fingerprints?.hash ?? null;
  const modelFingerprintsJson = fingerprints?.json ?? null;

  // ---- witness (non-blocking by design) -----------------------------
  let leafHash = body.content_hash;
  let leafScheme: 'v1' | 'v2' | 'v2.2' = 'v1';
  let witnessed = false;
  let witnessId: string | null = null;
  let witnessSig: string | null = null;

  // §9.6 — an event produced outside the witness path during an outage,
  // using the customer's own credentials, being recorded on reconnect.
  // It is explicitly NOT Scruple-witnessed, so we do not even attempt to
  // witness it now: doing so would date the leaf to the recovery rather
  // than to the event, and would imply a witness that did not happen.
  if (!body.continuity) {
    try {
      const res = await witness.witnessIteration({
        projectId: String(projectId),
        runSequence,
        contentHash: body.content_hash,
        inputHash: inputHash ?? undefined,
        workflowHash: workflowHash ?? undefined,
        modelFingerprintsHash: modelFingerprintsHash ?? undefined,
        machineManifestHash: body.machine_manifest_hash,
      });
      if (res?.leaf_hash) {
        leafHash = res.leaf_hash;
        leafScheme = res.leaf_scheme ?? 'v2';
        witnessed = true;
        witnessId = String(res.witness_id ?? '');
        witnessSig = String(res.signature ?? '');
      }
    } catch {
      // Deliberately swallowed: capture must not block on witness-server
      // health. The caller learns the truth from `witnessed` below.
    }
  }

  const info = conn()
    .prepare(
      // The five hashes are stored here as well as sent to the witness.
      // The witness's copy is the evidence; this copy is what makes a
      // receipt renderable and a leaf re-derivable when the witness is
      // unreachable — which, on this route, it has been for every event
      // that did not carry an explicit project_id. Storing only what we
      // managed to transmit would make the outage unreconstructable.
      `INSERT INTO iterations
         (project_id, run_sequence, timestamp, leaf_hash, output_hash,
          output_kind, output_content_type, output_bytes, prompt,
          witnessed, witness_id, witness_signature, witness_timestamp,
          leaf_scheme, leaf_kind, baseline_hash,
          platform_attestation_json, platform_attestation_status,
          continuity_json,
          input_hash, workflow_hash,
          model_fingerprints, model_fingerprints_hash,
          machine_manifest_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      runSequence,
      now,
      leafHash,
      body.content_hash,
      body.kind === 'model_write' ? 'checkpoint' : 'image',
      body.mime,
      `${body.kind} · ${body.mime}`,
      witnessed ? 1 : 0,
      witnessId,
      witnessSig,
      witnessed ? now : null,
      leafScheme,
      body.kind === 'model_write' ? 'training' : 'workflow',
      body.baseline_ref,
      body.attestation ? JSON.stringify(body.attestation) : null,
      attestationStatus,
      body.continuity ? JSON.stringify(body.continuity) : null,
      inputHash,
      workflowHash,
      modelFingerprintsJson,
      modelFingerprintsHash,
      body.machine_manifest_hash ?? null,
    );

  return v2Ok(
    {
      leaf_id: String(info.lastInsertRowid),
      leaf_hash: leafHash,
      // 201 means CAPTURED. It has never meant witnessed, and a client
      // that renders one as the other is making a claim the server did
      // not make (§5).
      witnessed,
      leaf_scheme: leafScheme,
      run_sequence: runSequence,
      baseline_ref: body.baseline_ref,
      attestation: attestationStatus ? { status: attestationStatus } : null,
      // What this leaf actually commits to. A caller that sent a graph
      // is entitled to see that it was folded in rather than dropped —
      // which is exactly what could not be seen before WO-1.
      input_hash: inputHash,
      workflow_hash: workflowHash,
      model_fingerprints_hash: modelFingerprintsHash,
      machine_manifest_hash: body.machine_manifest_hash ?? null,
      continuity_marked: Boolean(body.continuity),
    },
    201,
  );
}
