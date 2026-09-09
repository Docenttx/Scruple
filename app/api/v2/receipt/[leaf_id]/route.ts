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
import { discloseLeafSignature } from '@/lib/leaf/signatureDisclosure';
import { basisForTrust } from '@/lib/leaf/attestationBasis';

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
  attestation_basis: string | null;
  attestation_profile: string | null;
  continuity_json: string | null;
  // WO-S1(a) / migration 052.
  leaf_signature: string | null;
  leaf_signer_key_id: string | null;
  leaf_signature_alg: string | null;
  leaf_signer_surrogate: number | null;
  leaf_signature_state: string | null;
  canonicalization_profile: string | null;
  component_id: string | null;
  component_counter: number | null;
  component_verified: number | null;
  // WO-C2 / migration 054.
  resolution_witness_endpoint: string | null;
  resolution_witness_authority: string | null;
  resolution_checkpoint_id: string | null;
  resolution_prev_checkpoint_id: string | null;
  resolution_prev_checkpoint_quote_time: string | null;
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
              platform_attestation_status, attestation_basis, attestation_profile,
              continuity_json,
              leaf_signature, leaf_signer_key_id, leaf_signature_alg,
              leaf_signer_surrogate, leaf_signature_state,
              canonicalization_profile,
              component_id, component_counter, component_verified,
              resolution_witness_endpoint, resolution_witness_authority,
              resolution_checkpoint_id, resolution_prev_checkpoint_id,
              resolution_prev_checkpoint_quote_time
         FROM iterations WHERE id = ?`,
    )
    .get(Number(leaf_id)) as Row | undefined;

  if (!row) return v2Error('not_found', `No receipt for leaf ${leaf_id}.`);

  // WO-S1(a) — the seal, disclosed rather than asserted.
  const signature = discloseLeafSignature(row, row.leaf_hash);

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
    // WO-C1. The per-leaf basis, read through the ONLY reader a trust
    // decision may use. `basisForTrust()` maps absent, null and malformed to
    // 'unknown' — never to 'verified' — so a leaf written before migration
    // 053 reads as a leaf nobody asked the question of, which is what it is.
    //
    // ALWAYS PRESENT, INCLUDING WHEN IT IS 'unknown'. An absent key is a
    // fact nobody reads; 'unknown' is a fact a consumer can act on. This is
    // the same argument `component: null` won on the witness response.
    attestation_basis: {
      basis: basisForTrust(row.attestation_basis),
      profile: row.attestation_profile,
      // Every field-level `source: measured` on this leaf is conditional on
      // the basis above. One basis per leaf; there is no per-field pointer,
      // because twelve fields pointing at one basis still read as twelve
      // measurements to anyone not following the pointer.
      conditions_measured_fields: true,
    },
    // §9.6 — produced outside the witness path.
    continuity: parse(row.continuity_json),

    // ── WO-S1(a). ADDITIVE. Nothing above this line changed. ──────────
    //
    // What the leaf is actually sealed with, and what that is worth. The
    // witness has held these four since H-1 and this surface disclosed
    // none of them, so `independently_verifiable` was a claim the reader
    // had no way to test — and a surrogate-signed leaf was
    // indistinguishable from any other, which is exactly the per-leaf
    // two-tier honesty H-5 exists to provide.
    //
    // Every key inside is always present. `state` says which of the three
    // reasons a null means.
    signature,
    // Hoisted to the top level as well as sitting inside `signature`,
    // because it is the one field a caller reads to decide whether to
    // believe the rest, and burying it one level down invites the reading
    // that its absence means false.
    independently_verifiable: signature.independently_verifiable,

    // Which canonicalization rule this row's hashes were made under
    // (migration 049). Undisclosed until now, which made a live
    // divergence undetectable: the Blender client computed `jcs-1` where
    // the row records `jcs-2`, and no surface would show the reader the
    // two disagreed. NULL means no document was canonicalized for this
    // leaf — 046's "the question was never asked" — not a default.
    canonicalization_profile: row.canonicalization_profile,

    // H-4, per leaf. Present including when null, because "no component
    // MACed this event" is a fact a verifier needs and an absent key is a
    // fact nobody reads. `verified: false` beside a component_id is a
    // third thing again: one was named and it did not check out.
    component: row.component_id
      ? {
          component_id: row.component_id,
          counter: row.component_counter,
          verified: row.component_verified === 1,
        }
      : null,

    // ── WO-C2. WHERE THIS LEAF'S EVIDENCE IS RESOLVED. ────────────────
    //
    // The council split what a leaf CLAIMS from what it CARRIES AS EVIDENCE:
    // the Merkle inclusion path and the raw quote stay in the checkpoint
    // store, and the leaf carries the handles that say where to fetch them.
    // A receipt that disclosed the claims and not the handles would leave a
    // reader knowing what is asserted and having no way to go and check it.
    //
    // `signed` IS THE POINT, AND IT IS COMPUTED, NOT ASSERTED. The handles
    // are only safe because they are inside the ratchet MAC — otherwise "an
    // attacker who can rewrite an unsigned endpoint redirects resolution to
    // a service that will happily confirm anything." So this reports whether
    // the component envelope that covered them actually verified, and a
    // reader who sees `signed: false` beside a `witness_endpoint` knows to
    // follow nothing.
    //
    // ⚑ THE ENDPOINT IS WHAT THE COMPONENT SIGNED, not this server's own
    // address. It is never overwritten at ingest: a component naming
    // somewhere else is a fact, and rewriting it would destroy the only
    // record of it.
    //
    // null on a leaf that carries no handles — every leaf written before
    // migration 054, and every component-less caller since.
    resolution: row.resolution_witness_endpoint
      ? {
          witness_endpoint: row.resolution_witness_endpoint,
          witness_authority: row.resolution_witness_authority,
          checkpoint_id: row.resolution_checkpoint_id,
          prev_checkpoint_id: row.resolution_prev_checkpoint_id,
          prev_checkpoint_quote_time: row.resolution_prev_checkpoint_quote_time,
          signed: row.component_verified === 1,
        }
      : null,
  });
}
