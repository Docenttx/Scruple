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
