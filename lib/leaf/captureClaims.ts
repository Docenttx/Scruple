// The validator for what a component's `capture` block is allowed to claim.
//
// WO-C1. "Enforce in the validator, not in prose" is the sentence this file
// exists to satisfy, and the council earned the right to insist on it: the
// filesystem trigger was retracted in round 4, reinstated in round 6 by the
// same seat that retracted it, and three watchers missed the reinstatement.
// A rule that lives only in a paragraph gets re-enabled by the next
// contributor as a shortcut. A rule that returns 422 does not.
//
// PURE. No database, no environment, no network. The route calls it after
// `requireScope` and before anything writes.
//
// ---------------------------------------------------------------------------
// RULE 1 — `close_detection` IS REJECTED AS A PROVENANCE OR COMPLETION FIELD
// ---------------------------------------------------------------------------
//
// §1: "Filesystem observations are not freeze-gate authentication and
// `close_detection` is rejected as provenance." Round 11: "`IN_CLOSE_WRITE`,
// quiescence, and `fs-watch.ts` observations must not create, complete, or
// authenticate artifact leaves ... The validator must reject `close_detection`
// as a provenance or completion field, so this cannot return as a dead schema
// dependency."
//
// THE FIELD STAYS IN THE MAC PREIMAGE, PINNED AT null, and that is deliberate.
// Removing the key would change the canonical JSON and therefore every MAC,
// splitting the three preimage implementations for a cosmetic gain. Keeping it
// at null means the MAC covers the ASSERTION THAT THERE IS NO CLOSE DETECTION —
// a proxy cannot add one in flight without breaking the signature. The field is
// dead as provenance and load-bearing as a negative.
//
// Where does the observation go instead? `capture.fs_diagnostic`, which is
// NOT read by componentPreimage() and is stored as diagnostic corroboration.
// fs-watch may keep observing. It may not complete a leaf.
//
// ---------------------------------------------------------------------------
// RULE 2 — A NEW v1 LEAF MUST NOT EMIT `attestation_status: null`
// ---------------------------------------------------------------------------
//
// A capture block is what makes a leaf a component leaf, so a capture block is
// the boundary between "new v1 leaf" and "legacy". Canvas and the desktop
// plugins send no capture block; their leaves record no basis and
// `basisForTrust()` reads them as 'unknown'. That is honest — the question was
// never asked of them. A component that DOES send a capture block is emitting
// under this design and must say what conditions its measured fields.
//
// ---------------------------------------------------------------------------
// RULE 3 — `verified` ON THE DESKTOP PROFILE IS REJECTED
// ---------------------------------------------------------------------------
//
// The runtime half of "unrepresentable, not merely unlikely". The type-level
// half is `BasisOn<'desktop'>` in ./attestationBasis.ts, and it is not enough
// on its own: types do not survive JSON, and this is JSON.
//
// A submission that declares `verified` with NO profile is refused for the
// same reason absent-is-never-verified applies on the read side. An
// undeclared profile is not a claim of a strong one.
//
// ---------------------------------------------------------------------------
// RULE 4 — AND WHILE THE MERKLE BLOCKER STANDS, `stale` IS THE ONLY BASIS
// ---------------------------------------------------------------------------
//
// Appendix C item 0. This is the rule most likely to be read as excessive, so:
// it is the ⚑ line of WO-C1 ("Until WO-C6 lands, every new leaf emits
// `stale`") enforced where a prose version would rot. It applies ONLY to
// submissions carrying a capture block — the leaves emitted under this design.
// Nothing that witnesses today without one is affected.
//
// It lifts by flipping CHECKPOINT_VECTORS_SETTLED, which is WO-C6's
// deliverable and no test's.

import {
  CHECKPOINT_BLOCKER_REASON,
  CHECKPOINT_VECTORS_SETTLED,
  isAttestationBasis,
  isCaptureProfile,
  type AttestationBasis,
  type CaptureProfile,
} from '@/lib/leaf/attestationBasis';

export type CaptureClaimCode =
  | 'close_detection_rejected'
  | 'attestation_basis_required'
  | 'attestation_basis_refused';

export interface CaptureClaimRefusal {
  ok: false;
  code: CaptureClaimCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface CaptureClaimAccepted {
  ok: true;
  /** null when the submission carries no capture block: a legacy leaf. */
  basis: AttestationBasis | null;
  profile: CaptureProfile | null;
}

export type CaptureClaimResult = CaptureClaimAccepted | CaptureClaimRefusal;

/** Every place a `close_detection` could be smuggled in as provenance. */
function closeDetectionSites(
  body: Record<string, unknown>,
  capture: Record<string, unknown> | null,
): Array<{ at: string; value: unknown }> {
  const sites: Array<{ at: string; value: unknown }> = [];
  if ('close_detection' in body) sites.push({ at: 'close_detection', value: body.close_detection });
  if (capture && 'close_detection' in capture) {
    sites.push({ at: 'capture.close_detection', value: capture.close_detection });
  }
  return sites.filter((s) => s.value !== null && s.value !== undefined);
}

export function validateCaptureClaims(
  body: Record<string, unknown>,
  opts: { vectorsSettled?: boolean } = {},
): CaptureClaimResult {
  const settled = opts.vectorsSettled ?? CHECKPOINT_VECTORS_SETTLED;
  const capture =
    body.capture && typeof body.capture === 'object' && !Array.isArray(body.capture)
      ? (body.capture as Record<string, unknown>)
      : null;

  // ---- Rule 1 -------------------------------------------------------
  // Checked FIRST, and against a submission with no capture block too: a
  // caller that moved the field up a level has made exactly the claim the
  // rule refuses.
  const smuggled = closeDetectionSites(body, capture);
  if (smuggled.length > 0) {
    return {
      ok: false,
      code: 'close_detection_rejected',
      message:
        '`close_detection` is rejected as a provenance or completion field. A filesystem ' +
        'observation — IN_CLOSE_WRITE, quiescence, or anything fs-watch derives — must not ' +
        'create, complete or authenticate an artifact leaf: the authoritative artifact set is ' +
        'the byte stream of artifact-bearing HTTP and WebSocket responses, and the list of ' +
        'artifacts for which an on-disk copy is authoritative while the wire copy is not is ' +
        'EMPTY. Send the observation as `capture.fs_diagnostic` instead, where it is ' +
        'diagnostic corroboration and is not covered by the MAC. The `close_detection` key ' +
        'itself stays in the preimage pinned at null so a proxy cannot add one in flight.',
      detail: { rejected: smuggled },
    };
  }

  if (!capture) {
    // A legacy leaf: canvas, the plugins, a host with no component. No basis
    // is recorded and `basisForTrust()` will read it as 'unknown'.
    return { ok: true, basis: null, profile: null };
  }

  // ---- Rule 2 -------------------------------------------------------
  const raw = capture.attestation_status;
  if (!isAttestationBasis(raw)) {
    return {
      ok: false,
      code: 'attestation_basis_required',
      message:
        'A leaf carrying a `capture` block must declare `capture.attestation_status` as one of ' +
        '"verified" | "stale" | "passthrough". It was ' +
        (raw === undefined ? 'absent' : JSON.stringify(raw)) +
        '. Absent, null or malformed is NEVER read as verified — it resolves to `unknown` for ' +
        'trust decisions, and a leaf emitted under this design is not entitled to be unknown ' +
        'about its own basis. One basis per leaf; every field-level `source: measured` on it ' +
        'is conditional on this value.',
      detail: { received: raw ?? null, accepted: ['verified', 'stale', 'passthrough'] },
    };
  }
  const basis: AttestationBasis = raw;

  const declaredProfile = capture.profile;
  if (declaredProfile !== undefined && declaredProfile !== null && !isCaptureProfile(declaredProfile)) {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        '`capture.profile` must be one of "server-managed" | "isolated-sidecar" | "desktop" ' +
        'when present. The basis is conditional on the profile, so an unrecognised profile ' +
        'makes the basis unreadable rather than merely odd.',
      detail: { received: declaredProfile },
    };
  }
  const profile: CaptureProfile | null = isCaptureProfile(declaredProfile) ? declaredProfile : null;

  // ---- Rule 3 -------------------------------------------------------
  if (basis === 'verified' && profile === null) {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        'A leaf declaring `verified` must declare the profile that makes it representable. ' +
        'An undeclared profile is not a claim of a strong one — absent is never verified, on ' +
        'the write side for the same reason it is on the read side.',
      detail: { basis, profile: null },
    };
  }
  if (basis === 'verified' && profile === 'desktop') {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        '`verified` is unreachable on the desktop profile BY CONSTRUCTION, and this is a ' +
        'refusal rather than a downgrade. PCRs attest boot state; the threat is runtime root, ' +
        'which can LD_PRELOAD or eBPF-synthesize the entire coverage story after the quote was ' +
        'taken, and an interval bound cannot exclude a compromise inside its own interval. ' +
        '`verified` is reserved for a placement that can enforce the capture boundary against ' +
        'the tenant — a server-managed library, a genuinely isolated sidecar, or a CVM. ' +
        'Emit `stale` or `passthrough`.',
      detail: { basis, profile },
    };
  }

  // ---- Rule 4 -------------------------------------------------------
  if (!settled && basis !== 'stale') {
    return {
      ok: false,
      code: 'attestation_basis_refused',
      message:
        `A leaf emitted today must state \`stale\`; this one said \`${basis}\`. Because ` +
        CHECKPOINT_BLOCKER_REASON,
      detail: { basis, required: 'stale', checkpoint_vectors_settled: settled },
    };
  }

  return { ok: true, basis, profile };
}
