// GET /api/v2/baseline/current — what the server believes is installed.
//
// A 404 here is meaningful, not an error condition to paper over: per
// Standard §5 a tenant with no baseline is NOT Scruple-witnessed, and a
// client should say exactly that rather than showing a blank panel.

import type { NextRequest } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

interface Row {
  baseline_hash: string;
  prev_baseline_hash: string | null;
  manifest_json: string;
  attestation_provider: string;
  activated_at: string;
  witness_leaf_id: number | null;
}

export async function GET(req: NextRequest) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;

  const row = conn()
    .prepare(
      `SELECT baseline_hash, prev_baseline_hash, manifest_json,
              attestation_provider, activated_at, witness_leaf_id
         FROM baselines
        WHERE tenant_id = ? AND retired_at IS NULL
        ORDER BY activated_at DESC LIMIT 1`,
    )
    .get(gate.principal.userId) as Row | undefined;

  if (!row) {
    return v2Error(
      'not_found',
      'No baseline for this tenant. Until one is established the integration is not Scruple-witnessed (§5) and POST /api/v2/witness will refuse.',
    );
  }

  let manifest: unknown = null;
  try {
    manifest = JSON.parse(row.manifest_json);
  } catch {
    manifest = null;
  }

  return v2Ok({
    baseline_ref: row.baseline_hash,
    tamper_surface_hash: row.baseline_hash,
    previous_baseline_hash: row.prev_baseline_hash,
    established_at: row.activated_at,
    anchored: false,
    manifest,
    attestation_provider: row.attestation_provider,
    witness_leaf_id: row.witness_leaf_id,
  });
}
