// GET /api/v2/seal/deployments — every deployment this tenant has, and
// which side of the compliance line each one is on (WO-22).
//
// TENANT-SCOPED AND AUTHENTICATED, unlike GET /api/v2/builds. The build
// registry is a statement about what WE published and is public for that
// reason; a lifecycle state is a statement about a VENDOR'S deployment,
// and listing whose integrations are unsealed to anyone who asks would be
// an enumeration oracle over other people's compliance posture.
//
// READ-ONLY BY CONSTRUCTION. There is no POST, and lib/seal/cli.ts's
// header carries the argument: a deployment that can move its own
// lifecycle state is a vendor grading their own exam, and `sealed` is the
// state that lets a deployment claim the standard.

import { requireScope } from '@/lib/v2/auth';
import { v2Ok } from '@/lib/v2/http';
import { listDeployments, sealStatus } from '@/lib/seal/registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  // State is time-relative — a reseal does not reach backwards — so the
  // reference instant is a parameter rather than an assumption. Same
  // reason GET /api/v2/builds takes one.
  const at = new URL(req.url).searchParams.get('at') ?? undefined;

  const deployments = listDeployments(principal.userId).map((d) => {
    const st = sealStatus(d.deployment_id, at);
    return {
      deployment_id: d.deployment_id,
      label: d.label,
      created_at: d.created_at,
      state: st.state,
      claims_standard: st.claims_standard,
      seal_ref: st.seal_ref,
      sealed_at: st.sealed_at,
      seal_expires_at: st.seal_expires_at,
      reseal_cause: st.reseal_cause,
      drift_since_seal: st.drift_since_seal,
      drift_budget: st.drift_budget,
    };
  });

  return v2Ok({
    as_of: at ?? new Date().toISOString(),
    deployments,
    // The sentence a vendor is entitled to have in front of them when
    // they read this list, because a four-valued field is exactly the
    // shape someone reads as a ladder.
    note:
      'Compliance is binary. `sealed` is the only state that may claim the standard; ' +
      '`integrating`, `verifying` and `resealing` are the other side of that one line and ' +
      'not rungs below it. Leaves produced in those states are valid records of what ' +
      'happened and are not claims to the standard — they are stamped with the state they ' +
      'were written under so an audit can tell which configuration produced what.',
  });
}
