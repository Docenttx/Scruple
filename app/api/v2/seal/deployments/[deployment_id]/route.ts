// GET /api/v2/seal/deployments/{deployment_id}[?at=ISO8601]
//
// "Was this deployment sealed WHEN MY LEAF WAS WRITTEN, and against
// which configuration?" — the question an auditor holding an old leaf
// actually has, and the reason the lifecycle records a reseal as a dated
// signed event rather than as a mutable column. Without `at`, a reseal
// would answer for every leaf that deployment ever produced,
// retroactively, which is the failure §4.2 already refused for counter
// gaps: a later fact must not invalidate earlier evidence.
//
// A deployment belonging to another tenant answers 404 and NOT 403. A 403
// confirms the id exists, which turns this route into an oracle over
// other vendors' deployment names; "we have no such deployment for you"
// is both true and the only thing this caller is entitled to know.

import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { registryPublicKey } from '@/lib/builds/signing';
import { getDeployment, listSeals, sealStatus, verifySealMeasurement } from '@/lib/seal/registry';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ deployment_id: string }> },
) {
  const gate = requireScope(req, 'read');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  const { deployment_id } = await params;
  const id = decodeURIComponent(deployment_id);

  const dep = getDeployment(id);
  if (!dep || dep.tenant_id !== principal.userId) {
    return v2Error(
      'not_found',
      `No deployment ${JSON.stringify(id)} for this tenant. Deployments are registered by ` +
        'Scruple with the signing key (lib/seal/cli.ts); there is no self-serve route, ' +
        'because a deployment that can move its own lifecycle state can grant itself the ' +
        'right to claim the standard.',
    );
  }

  const at = new URL(req.url).searchParams.get('at') ?? undefined;
  const st = sealStatus(id, at);

  return v2Ok({
    deployment_id: st.deployment_id,
    label: dep.label,
    state: st.state,
    claims_standard: st.claims_standard,
    as_of: st.as_of,
    seal_ref: st.seal_ref,
    sealed_at: st.sealed_at,
    seal_expires_at: st.seal_expires_at,
    reseal_cause: st.reseal_cause,
    drift_since_seal: st.drift_since_seal,
    drift_budget: st.drift_budget,

    // EVERY seal this deployment has ever held, not just the current one.
    // A verifier holding a leaf stamped with an older seal_ref needs to
    // be able to fetch the manifest that was approved then; a list that
    // showed only the seal in force would make a superseded leaf
    // uncheckable, which is the exact thing the append-only shape exists
    // to prevent.
    seals: listSeals(id).map((s) => ({
      seal_ref: s.seal_ref,
      pipeline_measurement: s.pipeline_measurement,
      measurement_profile: s.measurement_profile,
      sealed_at: s.sealed_at,
      notes: s.notes,
      // The approved configuration, in full. A measurement nobody can
      // reproduce is a number rather than evidence.
      manifest: JSON.parse(s.manifest_json) as unknown,
      measurement_reproduces: verifySealMeasurement(s),
      signature: { alg: s.signature_alg, key_id: s.signing_key_id, value: s.signature },
    })),

    events: st.events.map((e) => ({
      event: e.event,
      effective_at: e.effective_at,
      seal_ref: e.seal_ref,
      change_class: e.change_class,
      reason: e.reason,
      signature: {
        alg: e.signature_alg,
        key_id: e.signing_key_id,
        value: e.signature,
        entry_sha256: e.entry_sha256,
      },
    })),

    signing_key: registryPublicKey(),

    limit:
      'A seal says this is the approved configuration. It does not say the running system ' +
      'IS that configuration — that is the attestation row\'s job (`verified` where the key ' +
      'is sealed to the measurement, `passthrough` where the binding is assertion). The ' +
      'measurement covers the declared manifest above and nothing else: not the OS, the ' +
      'runtime, the machine, or the installed dependency tree.',
  });
}
