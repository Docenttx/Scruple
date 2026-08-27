// GET /api/v2/receipt/{leaf_id} — what the user was actually given.
//
// Public and unauthenticated by design: a receipt whose verification
// requires the issuer's cooperation is not much of a receipt.
//
// This route is deliberately unflattering. It reports witnessed=false,
// outstanding modalities, and passthrough attestations exactly as they
// are, because the whole point of §5 and §12.4 is that a receipt must not
// read better than the evidence behind it.

import { conn } from '@/lib/db/sqlite';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  leaf_hash: string;
  output_hash: string;
  output_content_type: string;
  witnessed: number;
  leaf_scheme: string | null;
  baseline_hash: string | null;
  timestamp: string;
  modalities_requested: string | null;
  modalities_applied: string | null;
  modalities_outstanding: string | null;
  platform_attestation_status: string | null;
  continuity_json: string | null;
}

const parse = (s: string | null): unknown => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ leaf_id: string }> },
) {
  const { leaf_id } = await params;
  const row = conn()
    .prepare(
      `SELECT id, leaf_hash, output_hash, output_content_type, witnessed,
              leaf_scheme, baseline_hash, timestamp,
              modalities_requested, modalities_applied, modalities_outstanding,
              platform_attestation_status, continuity_json
         FROM iterations WHERE id = ?`,
    )
    .get(Number(leaf_id)) as Row | undefined;

  if (!row) return v2Error('not_found', `No receipt for leaf ${leaf_id}.`);

  return v2Ok({
    leaf_id: String(row.id),
    leaf_hash: row.leaf_hash,
    content_hash: row.output_hash,
    mime: row.output_content_type,
    witnessed: row.witnessed === 1,
    leaf_scheme: row.leaf_scheme ?? 'v1',
    baseline_ref: row.baseline_hash,
    witnessed_at: row.timestamp,
    // §9.5 — what the user asked for, not merely what survived.
    modalities_requested: parse(row.modalities_requested) ?? [],
    modalities_applied: parse(row.modalities_applied) ?? [],
    outstanding: parse(row.modalities_outstanding) ?? [],
    // §12.4 — never bare. null means no attestation was supplied, which
    // is an honest absence and reads differently from 'passthrough'.
    attestation: row.platform_attestation_status
      ? { status: row.platform_attestation_status }
      : null,
    // §9.6 — produced outside the witness path.
    continuity: parse(row.continuity_json),
  });
}
