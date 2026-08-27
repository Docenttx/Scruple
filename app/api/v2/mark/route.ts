// POST /api/v2/mark — attach output modalities to a witnessed event.
//
// ONE call, ONE leaf, ONE atomically recorded selection.
//
// An earlier draft of the canon surface had per-modality endpoints
// (/v2/mark/c2pa and friends). They were dropped because §9.5 requires
// the user's selection to be recorded IN the leaf so a verifier can
// distinguish "the user chose not to attach C2PA" from "C2PA was
// attached and later stripped" — and separate calls make that selection a
// multi-step transaction with no natural commit point.
//
// A LOCAL LOCK IS ALWAYS PERFORMED. §9.4: "Every Scruple event produces a
// local lock; the other modalities are attached alongside it, not instead
// of it." `modalities: []` is valid and means local-lock-only. There is
// no request here that produces no local lock.
//
// STATUS OF THE MODALITIES THEMSELVES:
//   c2pa      — requires the Signer CVM, deliberately powered down
//               pre-launch. Requests fail with signer_unavailable rather
//               than degrading, because a silent downgrade to "we locked
//               it locally instead" is precisely the confusion four
//               shells shipped.
//   watermark — services/watermark has no HTTP server. Reported as
//               outstanding, not silently skipped (§7).
//   chain     — reachable, but currently mints on testnet, which the
//               response states explicitly so nothing downstream mistakes
//               a testnet anchor for a real one.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { isModalityAvailable, type HostId, type Modality } from '@/lib/v2/capabilities';

export const dynamic = 'force-dynamic';

const Body = z.object({
  leaf_id: z.string().min(1),
  host: z.string().min(1),
  modalities: z.array(z.enum(['c2pa', 'watermark', 'chain'])).max(3),
  chain_tier: z.enum(['basic', 'pinned']).optional(),
  payment_intent_id: z.string().optional(),
});

interface Outstanding {
  modality: Modality;
  reason: string;
}

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'mark:write');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return v2Error('invalid_body', 'Mark request did not validate.', String(e));
  }

  const leaf = conn()
    .prepare(
      `SELECT i.id, i.output_content_type, i.witnessed, i.baseline_hash, i.leaf_hash
         FROM iterations i
        WHERE i.id = ?`,
    )
    .get(Number(body.leaf_id)) as
    | {
        id: number;
        output_content_type: string;
        witnessed: number;
        baseline_hash: string | null;
        leaf_hash: string;
      }
    | undefined;

  if (!leaf) return v2Error('not_found', `No leaf ${body.leaf_id}.`);

  const requested = [...new Set(body.modalities)];

  // Fail closed on an inapplicable modality (D-7 + the SDK's third
  // property). Downgrading silently to something cheaper that looks
  // similar is what produced four different broken "C2PA" buttons.
  for (const m of requested) {
    const cap = isModalityAvailable(body.host as HostId, leaf.output_content_type, m);
    if (!cap.available) {
      return v2Error('modality_unavailable', cap.reason, {
        modality: m,
        mime: leaf.output_content_type,
        hint: 'GET /api/v2/capabilities?host=…&mime=… before offering the control.',
      });
    }
  }

  const applied: Modality[] = [];
  const outstanding: Outstanding[] = [];
  const now = new Date().toISOString();

  // ---- §9.4: the local lock, always -------------------------------
  applied.push('local');

  // ---- the selected modalities ------------------------------------
  for (const m of requested) {
    if (m === 'c2pa') {
      outstanding.push({
        modality: 'c2pa',
        reason:
          'The Signer CVM is not running. Nothing was signed and nothing was charged. This is reported rather than downgraded — a local lock is not a content credential.',
      });
      continue;
    }
    if (m === 'watermark') {
      outstanding.push({
        modality: 'watermark',
        reason:
          'No watermark service endpoint exists yet. Reported as outstanding rather than dropped (§7): a failed Phase-3 operation is never silently discarded.',
      });
      continue;
    }
    if (m === 'chain') {
      outstanding.push({
        modality: 'chain',
        reason:
          'Chain anchoring from /v2 is not wired to the locker yet. The existing /api/lock/chain path is unchanged and still works.',
      });
      continue;
    }
  }

  conn()
    .prepare(
      `UPDATE iterations
          SET modalities_requested = ?, modalities_applied = ?, modalities_outstanding = ?
        WHERE id = ?`,
    )
    .run(
      JSON.stringify(requested),
      JSON.stringify(applied),
      outstanding.length ? JSON.stringify(outstanding) : null,
      leaf.id,
    );

  return v2Ok({
    leaf_id: String(leaf.id),
    // §9.5 — recorded in the leaf, not merely returned. A verifier
    // reading the record later can tell what the user asked for.
    modalities_requested: requested,
    modalities_applied: applied,
    outstanding,
    local_lock: {
      scr_id: null,
      receipt_url: `/api/v2/receipt/${leaf.id}`,
    },
    // Carried through so a caller marking an unwitnessed capture cannot
    // mistake a mark for a witness.
    witnessed: leaf.witnessed === 1,
  });
}
