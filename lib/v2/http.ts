// Shared HTTP shapes for the /v2 canon surface.
//
// Every /v2 route answers in one of these two shapes. The v1-era routes
// each invented their own error body, which is part of why six client
// forks each parsed failures differently.

import { NextResponse } from 'next/server';

export type V2ErrorCode =
  | 'unauthorized'
  | 'forbidden_scope'
  | 'invalid_body'
  | 'not_found'
  | 'baseline_required'
  | 'baseline_stale'
  | 'modality_unavailable'
  // WO-6. A well-formed submission whose H-4 §4.3 component envelope did
  // not verify: bad MAC, replayed or out-of-window counter, unknown or
  // retired component. 422 rather than 401, because the CALLER
  // authenticated fine — it is the component's claim about itself that
  // failed, and a 401 would send a vendor to look at their API key.
  | 'component_unverified'
  // WO-C1. Three refusals the Blender×ComfyUI council required be enforced in
  // the validator rather than in prose, because a prose rule failed exactly
  // that way inside the council itself: a retracted `IN_CLOSE_WRITE`
  // dependency was reinstated one round later by the seat that retracted it,
  // and three watchers missed it. 422 for all three — the caller
  // authenticated fine and the JSON parsed fine; the CLAIM is refused.
  //
  //   close_detection_rejected   a filesystem observation used as provenance
  //   attestation_basis_required a capture-bearing leaf that declared no basis
  //   attestation_basis_refused  a basis this leaf is not entitled to claim
  | 'close_detection_rejected'
  | 'attestation_basis_required'
  | 'attestation_basis_refused'
  // WO-C2. The resolution handles, and the rule that they are handles only
  // when the ratchet MAC covers them. Architect settled the claims-versus-
  // evidence split on exactly this condition: moving the Merkle path and the
  // raw quote out of the leaf makes the POINTER to them security-critical,
  // because "an attacker who can rewrite an unsigned endpoint redirects
  // resolution to a service that will happily confirm anything." 422 again —
  // the caller authenticated and the JSON parsed; the handle is refused.
  //
  //   resolution_handles_unsigned  a handle where the preimage does not read it
  //   resolution_handles_required  a leaf under this design that names no witness
  //   resolution_handles_refused   a handle this leaf is not entitled to claim
  | 'resolution_handles_unsigned'
  | 'resolution_handles_required'
  | 'resolution_handles_refused'
  // WO-C4. Storage confinement, measured per leaf. The council's chain: an
  // uncaptured runaway write exhausts blocks on a filesystem shared with the
  // ratchet state, the ratchet's local append cannot `fsync`, and because the
  // MAC is the BLOCKING half of emit() the gate fails closed — fail-closed
  // becomes fail-stopped, triggered by the artifact class the gate cannot
  // see. 422 for both: the caller authenticated and the JSON parsed; what is
  // refused is a claim about a filesystem.
  //
  //   storage_confinement_required  a capture-bearing leaf that measured nothing
  //                                 and did not say so
  //   storage_confinement_refused   a confinement value with no measurement
  //                                 behind it, or one sent outside the MAC
  | 'storage_confinement_required'
  | 'storage_confinement_refused'
  // WO-C5. A silent ComfyUI restart resets an in-memory history ring that
  // does not survive it, and reads as a normal short history. The component
  // now brackets `/system_stats` and `/history` and says which run answered.
  // 422 for both, for the reason above: the caller authenticated and the JSON
  // parsed; what is refused is a claim about the process being watched.
  //
  //   upstream_epoch_required  a capture-bearing leaf that did not say which
  //                            upstream run it observed, or whether it asked
  //   upstream_epoch_refused   a continuity with no measurement behind it, an
  //                            unmeasured source wearing a recoverable
  //                            reason, an internally contradictory pair, or
  //                            an upstream field sent outside the MAC
  | 'upstream_epoch_required'
  | 'upstream_epoch_refused'
  // WO-D6. The host hook has exactly two levels: a host that points its
  // ComfyUI address at the gate (blind, and it says so) and a host that
  // registered an adapter to supply the meaning a wire cannot carry. 422 for
  // both, for the reason above: the caller authenticated and the JSON parsed;
  // what is refused is a claim about who named the bytes.
  //
  //   host_semantics_required  a capture-bearing leaf that will not say which
  //                            level it ran at — and "blind" is free, so
  //                            absent is not Level 1, it is a leaf that is
  //                            merely thinner than an enriched one
  //   host_semantics_refused   a Level-2 claim with no adapter behind it, a
  //                            blind leaf naming a host anyway, a `supplied`
  //                            that supplied nothing, a `declined` shipping a
  //                            document, or a host field sent outside the MAC
  | 'host_semantics_required'
  | 'host_semantics_refused'
  // WO-E2. `declared_uncaptured` — the artifacts the upstream said it produced
  // that the component did not capture, and THE SCOPE THAT ENUMERATION RANGED
  // OVER. 422 for both, for the reason above: the caller authenticated and the
  // JSON parsed; what is refused is a completeness claim.
  //
  //   declared_uncaptured_required  a capture-bearing leaf that will not say
  //                                 what it enumerated over — and
  //                                 "not_enumerated" is free, so absent is not
  //                                 "nothing to report", it is a leaf whose
  //                                 absence set has no scope at all
  //   declared_uncaptured_refused   a closure claimed over a window the same
  //                                 leaf says it could not enumerate; an
  //                                 enumerated set with a null count, where 0
  //                                 is a count and null is "did not look"; a
  //                                 `not_enumerated` carrying a set anyway; a
  //                                 completeness `measured` while no
  //                                 independent observer exists; or a scope
  //                                 field sent outside the MAC
  | 'declared_uncaptured_required'
  | 'declared_uncaptured_refused'
  // WO-F3. WHAT ENTERED THE DOCUMENT FROM OUTSIDE IT. 422 for both, for the
  // reason the two above are: the caller authenticated and the JSON parsed;
  // what is refused is a provenance claim.
  //
  //   imported_datablocks_required  a submission that declares SOMETHING about
  //                                 imported datablocks and will not say how it
  //                                 was obtained, or an enumerated set with a
  //                                 null count — where 0 is a count and null is
  //                                 "nothing enumerated", which is spelled
  //                                 `source: "none"` and is free. Declaring
  //                                 nothing at all is also free, and is what
  //                                 every leaf written before WO-F3 says.
  //   imported_datablocks_refused   `source: "none"` carrying a set anyway; a
  //                                 document that disagrees with the signed
  //                                 counts, the signed source, or its own
  //                                 digest; a member with both a digest and a
  //                                 reason it has none, or with neither; an
  //                                 `imported_origin_observed: true` while no
  //                                 door in this estate observes an import; a
  //                                 scalar sent down into `capture`, where the
  //                                 preimage does not read it; and a
  //                                 precomputed `input_hash` beside a
  //                                 declaration, which would leave the
  //                                 declaration unbound to the leaf hash
  | 'imported_datablocks_required'
  | 'imported_datablocks_refused'
  // WO-C3. The other half of Architect's settle: a handle must say how long
  // the thing it points at will be there, and a deadline must be bound to a
  // clock somebody named. Two codes, because the two failures have different
  // fixes — one is "enrol the policy", the other is "your clock is wrong" —
  // and one code for both would send an operator to the wrong file.
  //
  //   retention_policy_unresolvable  a digest binding an identity, not a duration
  //   settlement_deadline_unbound    a deadline no named clock puts there
  | 'retention_policy_unresolvable'
  | 'settlement_deadline_unbound'
  | 'signer_unavailable'
  | 'conflict'
  | 'internal';

const STATUS: Record<V2ErrorCode, number> = {
  unauthorized: 401,
  forbidden_scope: 403,
  invalid_body: 400,
  not_found: 404,
  baseline_required: 409,
  baseline_stale: 409,
  modality_unavailable: 422,
  component_unverified: 422,
  close_detection_rejected: 422,
  attestation_basis_required: 422,
  attestation_basis_refused: 422,
  resolution_handles_unsigned: 422,
  resolution_handles_required: 422,
  resolution_handles_refused: 422,
  storage_confinement_required: 422,
  storage_confinement_refused: 422,
  upstream_epoch_required: 422,
  upstream_epoch_refused: 422,
  host_semantics_required: 422,
  host_semantics_refused: 422,
  declared_uncaptured_required: 422,
  declared_uncaptured_refused: 422,
  imported_datablocks_required: 422,
  imported_datablocks_refused: 422,
  retention_policy_unresolvable: 422,
  settlement_deadline_unbound: 422,
  signer_unavailable: 503,
  conflict: 409,
  internal: 500,
};

export interface V2Error {
  error: {
    code: V2ErrorCode;
    /**
     * Written for the person who will read it in a plugin's error toast,
     * not for a log grep. It says what went wrong and what to do about
     * it. Several v1 errors said only "Unauthorized", which is why the
     * Adobe plugins' auth failure went undiagnosed for six weeks.
     */
    message: string;
    detail?: unknown;
  };
}

export function v2Error(
  code: V2ErrorCode,
  message: string,
  detail?: unknown,
): NextResponse<V2Error> {
  return NextResponse.json({ error: { code, message, detail } }, { status: STATUS[code] });
}

export function v2Ok<T extends object>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status });
}
