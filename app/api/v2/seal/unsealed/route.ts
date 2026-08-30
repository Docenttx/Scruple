// GET /api/v2/seal/unsealed — every leaf written by a pipeline that was
// not sealed at the time (WO-22).
//
// This is the other half of "stamped, not refused", and it is the same
// surface GET /api/v2/builds/unrecognised is, for the same reason: a
// status nobody can read is the same as no status. Kohya is this estate's
// standing proof — the pod hook no-opped when an env var was absent, and
// a capture path gone dark produced the same observable as a quiet
// afternoon.
//
// It is also the answer to the question INTEGRATION_LIFECYCLE.md raises
// and does not answer: "the moment a vendor seals, they hold a pile of
// integration-era leaves indistinguishable from approved ones — and the
// first audit cannot tell which configuration produced what." This is
// where the first audit looks.

import { requireScope } from '@/lib/v2/auth';
import { v2Ok } from '@/lib/v2/http';
import { unsealedLeaves } from '@/lib/seal/registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? '200');
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  // The tenant filter is IN the query rather than applied to its result:
  // filtering a limited list gives one tenant a report that is empty
  // because another tenant's rows filled the page, which reads as
  // "nothing to see" and is the one thing this endpoint must never say by
  // accident. Same note as the unrecognised-builds report.
  const rows = unsealedLeaves(limit, principal.userId);

  return v2Ok({
    count: rows.length,
    leaves: rows.map((r) => ({
      leaf_id: String(r.leaf_id),
      deployment_id: r.deployment_id,
      seal_state: r.seal_state,
      seal_ref: r.seal_ref,
      component_id: r.component_id,
      timestamp: r.timestamp,
    })),
    note:
      'These leaves are VALID RECORDS OF WHAT HAPPENED. Nothing here failed: their MACs ' +
      'verified and their baselines were current. What is true of them is that the pipeline ' +
      'that produced them was not sealed at the time, so they are not claims to the ' +
      'standard. `integrating` and `verifying` are the ordinary states of step 1 and step 2 ' +
      'and leaves from them are expected. `resealing` means an approved deployment changed ' +
      'and has not been re-approved. `unregistered` means a deployment id was declared that ' +
      'we have no record of for you — usually a typo, and worth chasing. `unchecked` is our ' +
      'failure, not yours. Leaves with no state at all were written before the lifecycle ' +
      'existed and are not listed: a question that was never asked is not an answer.',
  });
}
