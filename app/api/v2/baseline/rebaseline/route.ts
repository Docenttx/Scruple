// POST /api/v2/baseline/rebaseline — transition to a new baseline.
//
// Standard §4: re-baselining "is itself a Scruple-signed leaf
// ('integration baseline transitioned from X to Y at time T'). It is a
// first-class public event in the audit chain, linked to prior baselines
// by hash."
//
// The v1 implementation left witness_leaf_id permanently null, which
// removed the one property that makes §4 mean anything — that the change
// is ON THE RECORD rather than merely recorded. Silent modification is
// supposed to be cryptographically impossible; with a null leaf id it was
// merely inconvenient.
//
// So this route REFUSES to transition unless it can emit a leaf. That is
// deliberate and it is the strict reading: a re-baseline that produces no
// leaf is not a re-baseline, it is an unlogged substitution.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { witness } from '@/lib/scruple/witness';

export const dynamic = 'force-dynamic';

const Body = z.object({
  tamper_surface_hash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.enum([
    'sdk_upgrade', 'config_change', 'host_upgrade', 'capture_point_change', 'other',
  ]),
  detail: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'baseline:write');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return v2Error('invalid_body', 'Rebaseline request did not validate.', String(e));
  }

  const current = conn()
    .prepare(
      `SELECT baseline_hash, manifest_json FROM baselines
        WHERE tenant_id = ? AND retired_at IS NULL
        ORDER BY activated_at DESC LIMIT 1`,
    )
    .get(principal.userId) as { baseline_hash: string; manifest_json: string } | undefined;

  if (!current) {
    return v2Error(
      'baseline_required',
      'There is no baseline to transition from. Establish one with POST /api/v2/baseline first.',
    );
  }
  if (current.baseline_hash === body.tamper_surface_hash) {
    return v2Error(
      'conflict',
      'The tamper surface is unchanged, so there is nothing to transition. §4 is about material change; recording a no-op transition would put noise in the audit chain.',
    );
  }

  const now = new Date().toISOString();

  // §4's leaf. Emitted BEFORE the transition is committed — if the
  // witness is unreachable we decline the transition rather than
  // completing it unlogged.
  // The witness returns witness_id as a STRING, which is why
  // baselines.witness_leaf_id (INTEGER, migration 032) was never
  // populated and §4 was never really implemented. Migration 040 adds
  // witness_leaf_ref TEXT for it.
  //
  // The leaf lands on a synthetic `baseline:<tenant>` stream.
  // WitnessIterationInput documents projectId as free-form, so this is
  // within its contract — but §4 calls a baseline transition "a
  // first-class public event in the audit chain", and a project-scoped
  // stream is not quite that. Moving it onto the audit-log stream is
  // part of the same work as H-1 (L2_FLOOR.md) and is not done here.
  let leafRef: string | null = null;
  try {
    const res = await witness.witnessIteration({
      projectId: `baseline:${principal.userId}`,
      projectName: 'integration-baseline',
      runSequence: 0,
      contentHash: body.tamper_surface_hash,
      inputHash: current.baseline_hash,
    });
    if (!res || !res.witness_id) throw new Error('witness returned no witness_id');
    leafRef = String(res.witness_id);
  } catch (e) {
    return v2Error(
      'signer_unavailable',
      'The witness is unreachable, so this baseline transition cannot be recorded as a leaf. §4 requires the change to be a witnessed event, so the transition is declined rather than applied silently. Retry when the witness is reachable.',
      String(e),
    );
  }

  const tx = conn().transaction(() => {
    conn()
      .prepare(`UPDATE baselines SET retired_at = ? WHERE tenant_id = ? AND retired_at IS NULL`)
      .run(now, principal.userId);
    conn()
      .prepare(
        `INSERT INTO baselines
           (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
            attestation_provider, attestation_envelope_json,
            signer_pubkey_spki_sha256_hex, reason, submitted_at, activated_at,
            witness_leaf_ref)
         VALUES (?, ?, ?, ?, 'none', NULL, 'PENDING-H1-CVM-SIGNING', ?, ?, ?, ?)`,
      )
      .run(
        principal.userId,
        body.tamper_surface_hash,
        current.baseline_hash,
        current.manifest_json,
        body.detail ? `${body.reason}: ${body.detail}` : body.reason,
        now,
        now,
        leafRef,
      );
  });
  tx();

  return v2Ok(
    {
      baseline_ref: body.tamper_surface_hash,
      tamper_surface_hash: body.tamper_surface_hash,
      previous_baseline_hash: current.baseline_hash,
      established_at: now,
      anchored: false,
      // Never null. If we could not produce one we returned 503 above.
      witness_leaf_ref: leafRef,
    },
    201,
  );
}
