// GET /api/v2/resolve/{leaf_id} — follow a leaf's resolution handles, and get
// a NAMED answer.
//
// WO-C3. SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact `1a978a6`, §1, §2
// Architect's and IT Expert's rulings, hand round 7 §2, Appendix C).
//
// ---------------------------------------------------------------------------
// WHY THIS ROUTE EXISTS
// ---------------------------------------------------------------------------
//
// WO-C2 took the Merkle path and the raw quote OUT of the leaf and left a
// handle pointing at them. Architect settled that split on two conditions.
// The first was that the handles be signed. The second is this route:
//
//   "the `retention_policy_digest` must bind evidence RETENTION DURATION, not
//    just policy identity, so a resolution attempt after the evidence is
//    legitimately gone yields a NAMED `evidence_expired` STATE rather than
//    being indistinguishable from a forged handle."
//
// Before this route there was nowhere to attempt a resolution. A verifier's
// only door was `GET /api/v2/receipt/{id}`, which answers 200 or 404 — and a
// leaf whose evidence had been legitimately reaped and a leaf id nobody ever
// issued produced BYTE-IDENTICAL 404s. That run is recorded at
// /mnt/corpus/scruple-council-impl/wo-c3/01-controls-RED.txt.
//
// ---------------------------------------------------------------------------
// THREE STATES, AND WHY THEY ALL ARRIVE AS HTTP 200
// ---------------------------------------------------------------------------
//
//   resolvable        go and fetch the evidence; it is inside its window
//   evidence_expired  it was kept for the duration this leaf's SIGNED policy
//                     binds, and that has elapsed. Legitimately gone.
//   unresolvable      no such leaf, or a handle that is not the one signed
//
// ⚑ ALL THREE ANSWER 200, INCLUDING THE UNKNOWN LEAF, and that is deliberate
// rather than sloppy REST. A 404 is what a verifier also gets from a proxy
// that lost the route, a firewall, a typo'd host and a service that has been
// decommissioned. Putting the state in the STATUS LINE puts the one thing the
// council required be unambiguous into the one field that is ambiguous by
// operational reality. The state is in the body, where the answer is the
// server's and not the network's.
//
// The route is public and unauthenticated, for `receipt`'s reason: a receipt
// whose verification requires the issuer's cooperation is not much of a
// receipt, and neither is a resolution.

import { conn } from '@/lib/db/sqlite';
import { v2Ok } from '@/lib/v2/http';
import {
  evaluateEvidence,
  evaluateSettlement,
  type SettlementRow,
} from '@/lib/leaf/settlement';

export const dynamic = 'force-dynamic';

interface Row extends SettlementRow {
  id: number;
  leaf_hash: string;
  witnessed: number;
  component_verified: number | null;
  resolution_witness_endpoint: string | null;
  resolution_witness_authority: string | null;
  resolution_prev_checkpoint_id: string | null;
  resolution_prev_checkpoint_quote_time: string | null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ leaf_id: string }> },
) {
  const { leaf_id } = await params;
  const url = new URL(req.url);

  // WHAT THE VERIFIER IS HOLDING. Following a handle means going to the
  // address it names WITH THE VALUES IT CARRIES — so the two handles a
  // verifier could be holding a forged copy of are accepted as query
  // parameters and compared against what was signed. A mismatch is
  // `unresolvable`, not a resolvable leaf that happens to disagree: the leaf in
  // the verifier's hand is not the leaf this server issued.
  //
  // Both are OPTIONAL. A verifier that supplies neither is asking the weaker
  // question — "is this leaf's evidence still there" — and gets an honest
  // answer to it.
  const supplied = {
    retention_policy_digest: url.searchParams.get('retention_policy_digest'),
    checkpoint_id: url.searchParams.get('checkpoint_id'),
  };

  const id = Number(leaf_id);
  const row = Number.isSafeInteger(id)
    ? (conn()
        .prepare(
          `SELECT id, leaf_hash, witnessed, component_verified,
                  resolution_witness_endpoint, resolution_witness_authority,
                  resolution_checkpoint_id, resolution_prev_checkpoint_id,
                  resolution_prev_checkpoint_quote_time,
                  resolution_settlement_deadline, resolution_retention_policy_digest,
                  settlement_clock, settlement_clock_authority,
                  settlement_observed_at, evidence_retained_until
             FROM iterations WHERE id = ?`,
        )
        .get(id) as Row | undefined) ?? null
    : null;

  const evidence = evaluateEvidence(row, supplied);
  const settlement = row
    ? evaluateSettlement(row)
    : {
        state: 'unknown' as const,
        terminal: false,
        source: 'unknown' as const,
        deadline: null,
        clock: null,
        says: 'there is no leaf here to have a deadline.',
      };

  return v2Ok({
    leaf_id,
    // THE NAMED STATE. One of exactly three, and `reason` is only ever set on
    // `unresolvable` — where it separates a forged handle from a leaf written
    // before this design required a retention binding. Those are different
    // facts and collapsing them would recreate, one level down, the collapse
    // this route exists to end.
    resolution: evidence.state,
    reason: evidence.reason,
    says: evidence.says,
    evidence: {
      retained_until: evidence.retained_until,
      // MEASURED means: a named clock was read to decide this. It is 'unknown'
      // for a leaf carrying no retention binding, and it is never inferred.
      source: evidence.source,
      clock: evidence.clock,
    },
    // Architect's other half: when silence becomes a finding. `expired` here
    // is TERMINAL and is an assertion about the COMPONENT'S DELIVERY, not
    // about the leaf's validity — the leaf is exactly as valid as it was.
    settlement,
    // Where to actually go, for a verdict of `resolvable`. Echoed from the
    // row, which holds what the COMPONENT SIGNED — never this server's own
    // address. `signed: false` beside an endpoint means follow nothing.
    handles: row
      ? {
          witness_endpoint: row.resolution_witness_endpoint,
          witness_authority: row.resolution_witness_authority,
          checkpoint_id: row.resolution_checkpoint_id,
          prev_checkpoint_id: row.resolution_prev_checkpoint_id,
          prev_checkpoint_quote_time: row.resolution_prev_checkpoint_quote_time,
          settlement_deadline: row.resolution_settlement_deadline,
          retention_policy_digest: row.resolution_retention_policy_digest,
          signed: row.component_verified === 1,
        }
      : null,
    // ⚑ NOT DISCLOSED ON AN UNRESOLVABLE LEAF, and this is the one place the
    // route is deliberately unhelpful. Returning the leaf hash beside
    // `unresolvable / unknown_leaf` would let a caller walk the id space and
    // learn which ids exist; returning it beside `handle_mismatch` would hand
    // back the correct handle to whoever supplied a wrong one, which is an
    // oracle for the exact substitution the digest exists to prevent.
    leaf_hash: evidence.state === 'unresolvable' ? null : (row?.leaf_hash ?? null),
  });
}
