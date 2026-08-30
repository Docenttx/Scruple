// POST /api/v2/components/provision — key injection for a capture
// component (H-4 §4.4).
//
// The component starts, presents its one-time token, declares the build
// it is running, and receives its IK over TLS. The server burns the
// token and records the component at n=0.
//
// This is the one route in the estate that returns key material in a
// response body. That is deliberate and it is the injection ceremony: in
// payments the equivalent step happens once, in a certified facility,
// under dual control. Here it happens once, over TLS, against a
// single-use short-TTL token. Everything downstream of it — every event
// MAC — is derived, never transmitted.
//
// AUTH. Two credentials, both required:
//
//   * a bearer API key carrying `component:provision`, which says WHO is
//     calling. §4.4 does not mention one; requiring it is stricter than
//     the spec, and it is what makes "this token belongs to another
//     tenant" a checkable statement rather than an unenforceable comment.
//
//     THIS USED TO BE `baseline:write`, as a stand-in, because V2_SCOPES
//     belonged to another work order. §10 C-5 called that out and WO-6
//     closed it: `component:provision` is now a real scope, and it is a
//     different act from declaring a baseline — this is the one route in
//     the estate that hands back key material. Keys already carrying
//     `baseline:write` keep working, because lib/v2/auth.ts grants
//     `component:provision` from it (V2_SCOPE_GRANTS); that grant is a
//     deprecation with a removal condition, not a permanent alias.
//
//   * the one-time provisioning token, which says WHICH component.
//
// A vendor deploying the component therefore configures it with a scoped
// key and a token. Neither alone provisions anything.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireScope } from '@/lib/v2/auth';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { redeemProvisioningToken } from '@/lib/ratchet/provisioning';

export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(8),
  // §4.3 — "the analogue of a terminal's firmware version riding in the
  // transaction". Shaped, not merely non-empty, because a measurement we
  // cannot compare to a published build is decoration.
  build_measurement: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'must be "sha256:" followed by 64 lowercase hex chars'),
  attestation: z
    .object({
      provider: z.string().min(1),
      quote_ref: z.string().min(1).optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const gate = requireScope(req, 'component:provision');
  if ('response' in gate) return gate.response;
  const { principal } = gate;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return v2Error('invalid_body', 'Component provisioning request did not validate.', String(e));
  }

  const result = redeemProvisioningToken({
    token: body.token,
    tenantId: principal.userId,
    buildMeasurement: body.build_measurement,
    attestation: body.attestation ?? null,
  });

  if (!result.ok) {
    // A consumed or expired token and a token belonging to someone else
    // all answer 404 with the same body. The difference is useful to an
    // attacker probing for live tokens and useless to a component, which
    // must re-provision in every one of those cases — the same reasoning
    // principalFrom() applies to key lookup in lib/v2/auth.ts.
    if (result.reason === 'wrong_tenant' || result.reason === 'unknown_token') {
      return v2Error(
        'not_found',
        'No usable provisioning token. Issue a new one from the vendor console.',
      );
    }
    return v2Error('conflict', result.message, { reason: result.reason });
  }

  return v2Ok(
    {
      component_id: result.componentId,
      // Returned exactly once. The component seals it (§4.4 step 4) —
      // to the TPM/SEV measurement where available, else a 0600 file
      // owned by a user the tenant is not. If the seal cannot be
      // restored on restart the component re-provisions as a NEW
      // component_id at n=0; it must never guess a counter under this id.
      ik_hex: result.ikHex,
      counter: result.counter,
      build_measurement: result.buildMeasurement,
      // H-5. 'passthrough' is not a lesser grade of compliance; it is
      // this leaf declaring what backed it. Both are compliant, and the
      // receipt says which.
      attestation: result.attestationStatus ? { status: result.attestationStatus } : null,
      provisioned_at: result.provisionedAt,
      key_schedule: {
        // So a component implementer never has to guess, and so a
        // mismatch shows up at provisioning rather than at the first
        // rejected MAC.
        ik: 'HKDF-SHA256(ikm=BDK, salt=component_id, info="scruple/ik/v1", L=32)',
        mac_key: 'HKDF-Expand(K_n, "scruple/mac/v1", 32)',
        next_chain_key: 'HKDF-Expand(K_n, "scruple/ratchet/v1", 32)',
        mac: 'HMAC-SHA256(M_n, canonical_preimage)',
        order: 'derive, MAC, ratchet, then enqueue',
      },
    },
    201,
  );
}
