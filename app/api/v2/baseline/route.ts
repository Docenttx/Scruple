// POST /api/v2/baseline — establish the tenant's genesis baseline.
//
// Standard §3: the baseline "is the tenant's genesis leaf", and §2 says
// the integration itself is witnessed, not merely the work it produces.
//
// No integration has ever called the equivalent v1 route. This one is
// reachable with the same bearer key a plugin already holds, which the v1
// route was not — it required a tenant HMAC the official SDK never sent.
//
// NOTE ON ASSURANCE (D-0). A baseline established here is currently
// sealed by the witness server's HMAC, not by the Signer CVM's
// HSM-resident key. Per docs/canon/L2_FLOOR.md that is below the C2PA L2
// bar this same system meets for C2PA manifests, and harmonizing it (H-1)
// is outstanding work. The route is written so that swapping the seal
// changes one call site and no caller.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

const Body = z.object({
  host: z.string().min(1),
  integration_version: z.string().min(1),
  tamper_surface_hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars'),
  host_version: z.string().optional(),
  attestation: z
    .object({ type: z.string().min(1), report: z.string().min(1) })
    .optional(),
  anchor_publicly: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'baseline:write');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return v2Error('invalid_body', 'Baseline request did not validate.', String(e));
  }

  const now = new Date().toISOString();

  // §12.4 — an attestation is either root-verified or explicitly
  // passthrough. There is no third state that presents as verified.
  // Real chain-to-vendor-root verification is not wired yet (all six
  // verifier plugins are structural-only), so anything supplied here is
  // honestly recorded as passthrough rather than flattered.
  const attestationStatus: 'verified' | 'passthrough' | null = body.attestation
    ? 'passthrough'
    : null;

  const existing = conn()
    .prepare(
      `SELECT baseline_hash FROM baselines
        WHERE tenant_id = ? AND retired_at IS NULL
        ORDER BY activated_at DESC LIMIT 1`,
    )
    .get(principal.userId) as { baseline_hash: string } | undefined;

  if (existing) {
    return v2Error(
      'conflict',
      'This tenant already has an active baseline. Use POST /api/v2/baseline/rebaseline to transition — §4 requires a baseline change to be a witnessed event, not a silent replacement.',
      { current_baseline_ref: existing.baseline_hash },
    );
  }

  const manifest = {
    host: body.host,
    integration_version: body.integration_version,
    host_version: body.host_version ?? null,
  };

  conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
          attestation_provider, attestation_envelope_json,
          signer_pubkey_spki_sha256_hex, reason, submitted_at, activated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'genesis', ?, ?)`,
    )
    .run(
      principal.userId,
      body.tamper_surface_hash,
      JSON.stringify(manifest),
      body.attestation?.type ?? 'none',
      body.attestation ? JSON.stringify(body.attestation) : null,
      // Placeholder until H-1 moves leaf signing into the CVM. Recorded
      // as an explicit marker rather than a plausible-looking hash so it
      // cannot be mistaken for a real signer identity.
      'PENDING-H1-CVM-SIGNING',
      now,
      now,
    );

  return v2Ok(
    {
      baseline_ref: body.tamper_surface_hash,
      tamper_surface_hash: body.tamper_surface_hash,
      established_at: now,
      anchored: false,
      attestation: attestationStatus ? { status: attestationStatus } : null,
    },
    201,
  );
}
