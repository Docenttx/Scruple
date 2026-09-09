// The per-leaf attestation basis. Three values, one per leaf, and it is the
// thing every field-level `source: measured` on that leaf is conditional on.
//
// SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact 1a978a6, §1 and Appendix C).
// docs/wo/2026-09-09-council-implementation.md WO-C1 is the work order.
//
// ---------------------------------------------------------------------------
// ONE BASIS PER LEAF. NO PER-FIELD `basis_ref`.
// ---------------------------------------------------------------------------
//
// The rejected alternative was a pointer on every measured field back to the
// basis that conditions it. It was rejected for a reason worth keeping in the
// file that implements the winner: twelve fields pointing at one basis still
// read as twelve measurements to anyone not following the pointer. One value,
// at the top of the leaf, cannot be read past.
//
// ---------------------------------------------------------------------------
// WHY THREE VALUES AND NOT TWO
// ---------------------------------------------------------------------------
//
//   'verified'     the quote is root-chained AND BINDS TO THIS EMISSION.
//   'stale'        there is a quote, or there is meant to be one, and it
//                  cannot be bound to this emission. Also: the checkpoint the
//                  leaf would settle against cannot be claimed settled.
//   'passthrough'  no root-chained attestation at all. Stored opaquely;
//                  §12.4's "Stored MUST NOT read as verified".
//
// `stale` IS NOT FOLDED INTO `passthrough`, and that is the whole of round 10's
// amendment: they are different operational conditions with different fixes.
// `passthrough` says "this placement has no attestable compute" — the fix is a
// different placement. `stale` says "it has one and the binding broke" — the
// fix is to repair the nonce path or the checkpoint. Collapsing them tells an
// operator to buy hardware they already own.
//
// ---------------------------------------------------------------------------
// ABSENT OR MALFORMED IS NEVER `verified`
// ---------------------------------------------------------------------------
//
// `basisForTrust()` below is the only reader a trust decision may use. It maps
// absent, null, and anything not in the enum to 'unknown' — a fourth value
// that exists ONLY on the read side, for leaves written before this design.
// It is deliberately not a member of ATTESTATION_BASES: nothing may EMIT
// 'unknown', because "we did not record it" is a property of an old row, not
// a claim a new leaf is entitled to make.
//
// ---------------------------------------------------------------------------
// ⚑ `verified` IS UNREACHABLE ON THE DESKTOP PROFILE BY CONSTRUCTION
// ---------------------------------------------------------------------------
//
// Not unlikely. Unrepresentable. §1: "A desktop deployment may record measured
// observations, signed client requests, counters, refusal events, and witness
// settlement state, but it cannot represent `verified`: that value is
// unreachable by schema and validation on the desktop profile. TPM quotes do
// not change this, because they attest boot state, not runtime behavior after
// a privileged compromise."
//
// Loki's closing position is the reason it is structural rather than
// rhetorical: on a box where the measured party has root, that party can
// LD_PRELOAD or eBPF-synthesize the entire coverage story, and an interval
// bound cannot exclude a compromise inside its own interval. A PCR attests
// what booted. The threat is what happened after.
//
// So `verified` is excluded THREE ways, and each one is load-bearing on its
// own because the other two can be bypassed by a different kind of mistake:
//
//   1. at the TYPE level      — `BasisOn<'desktop'>` does not include it, so
//                               desktop-shaped code cannot be written;
//   2. in the RESOLVER        — resolveAttestationBasis() refuses to return
//                               it for a desktop profile whatever it is fed;
//   3. in the VALIDATOR       — lib/leaf/captureClaims.ts rejects a wire leaf
//                               that declares it. Types do not survive JSON.
//
// §1's phrase "and requires `host-enforced-signature`" is read here as an
// ADDITIONAL requirement on the placement, not as a redefinition of which
// placements qualify: the same sentence reserves `verified` for "a
// server-managed library, genuinely isolated sidecar, or CVM", and
// lib/capture/surface.ts already requires `isolated-namespace` (not a
// signature) of a sidecar. Both halves are enforced below via
// `verifiedIsRepresentable()`: a non-desktop profile AND an enforcement that
// is not 'none'. The tension is recorded rather than silently resolved.
//
// ---------------------------------------------------------------------------
// ⚑ AND UNTIL WO-C6 LANDS, EVERY NEW LEAF EMITS `stale`
// ---------------------------------------------------------------------------
//
// Appendix C item 0, verbatim:
//
//   "Until witness and verifier pass SHARED VECTORS for the canonical
//    preimage, domain separation, tree ordering, root calculation and proof
//    format, every emitted leaf must state `stale`. It cannot claim a settled
//    checkpoint."
//
// Measured 2026-09-09: three live Merkle constructions that do not agree
// (`lib/scruple/merkle.ts` sorted-pair, no domain separation;
// `lib/witness/merkle.ts` RFC 6962; `/opt/scruple-witness/server.js:490` hex
// concat), and the witness anchors whichever root the caller supplies. "The
// root" is not a well-defined value today, so no checkpoint can be claimed
// settled by anybody.
//
// THAT SENTENCE IS A CONSTANT IN THIS FILE AND NOT A COMMENT ANYWHERE,
// because the council's own failure mode — twice — was a retracted
// requirement surviving as prose and being re-enabled by the next
// contributor. WO-C6 flips CHECKPOINT_VECTORS_SETTLED when the vectors pass.
// Nothing else may.

import type { Placement, PlacementEnforcement } from '@/lib/capture/surface';

/* ────────────────────────────────────────────────────────────────────────
 * The basis.
 * ──────────────────────────────────────────────────────────────────────── */

export const ATTESTATION_BASES = ['verified', 'stale', 'passthrough'] as const;
export type AttestationBasis = (typeof ATTESTATION_BASES)[number];

/**
 * What a READER gets. 'unknown' is not emittable — see the header. A leaf
 * written before migration 053 has no basis recorded, and the honest answer
 * to "what conditioned its measured fields" is that nobody asked.
 */
export type TrustBasis = AttestationBasis | 'unknown';

/* ────────────────────────────────────────────────────────────────────────
 * The three trust profiles (§1, "three distinct trust profiles").
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * DERIVED FROM PLACEMENT, NEVER SELF-DECLARED WITHOUT ONE. `profileFor()` is
 * the only constructor, and it takes the EFFECTIVE placement — the one
 * `resolvePlacement()` produced after checking the enforcement mechanism, not
 * the one the host asked for. DEFECT-1 in PLACEMENT_AND_SURFACES.md is the
 * same defect one level up: a profile a host assigns itself is a claim.
 *
 *   'server-managed'    the vendor's own backend. The measured party has no
 *                       code execution in the capture process at all.
 *   'isolated-sidecar'  a container/namespace the measured party has no exec,
 *                       debug or filesystem access to. Includes the CVM case.
 *   'desktop'           the measured party has root on the box the capture
 *                       code runs on. Blender, Fusion, a local ComfyUI, an
 *                       unsigned add-on, a browser page. `verified` is
 *                       unreachable here BY CONSTRUCTION.
 *
 * `attested-client` lands on 'desktop' deliberately. A host-signature check at
 * load is a real boundary against a casual edit and no boundary at all against
 * the root that can rewrite the loader — and `attested-client` in this estate
 * IS the desktop plugin case (Blender, Fusion), which is precisely the
 * placement Loki's argument is about.
 */
export const CAPTURE_PROFILES = ['server-managed', 'isolated-sidecar', 'desktop'] as const;
export type CaptureProfile = (typeof CAPTURE_PROFILES)[number];

export function profileFor(effectivePlacement: Placement): CaptureProfile {
  switch (effectivePlacement) {
    case 'server-library':
      return 'server-managed';
    case 'sidecar-gate':
      return 'isolated-sidecar';
    case 'attested-client':
    case 'unattested-client':
      return 'desktop';
  }
}

/**
 * THE TYPE-LEVEL HALF OF "UNREPRESENTABLE, NOT MERELY UNLIKELY".
 *
 * Code that knows it is on the desktop cannot be written to produce
 * 'verified': `const b: BasisOn<'desktop'> = 'verified'` does not compile.
 */
export type DesktopAttestationBasis = Exclude<AttestationBasis, 'verified'>;
export type BasisOn<P extends CaptureProfile> = P extends 'desktop'
  ? DesktopAttestationBasis
  : AttestationBasis;

export function isCaptureProfile(v: unknown): v is CaptureProfile {
  return typeof v === 'string' && (CAPTURE_PROFILES as readonly string[]).includes(v);
}

export function isAttestationBasis(v: unknown): v is AttestationBasis {
  return typeof v === 'string' && (ATTESTATION_BASES as readonly string[]).includes(v);
}

/**
 * The ONLY reader a trust decision may use. Absent, null, malformed, a string
 * from a future version, a number, an object — all 'unknown'. There is no
 * branch in this function that can return 'verified' for input that is not
 * literally the string 'verified'.
 */
export function basisForTrust(v: unknown): TrustBasis {
  return isAttestationBasis(v) ? v : 'unknown';
}

/**
 * Whether `verified` may be represented at all for this profile+enforcement.
 * Both halves of §1's sentence, and neither is redundant: a desktop with
 * `host-enforced-signature` still fails on the profile, and a sidecar whose
 * namespace isolation degraded to 'none' still fails on the enforcement.
 */
export function verifiedIsRepresentable(
  profile: CaptureProfile,
  enforcement: PlacementEnforcement,
): boolean {
  return profile !== 'desktop' && enforcement !== 'none';
}

/* ────────────────────────────────────────────────────────────────────────
 * The checkpoint blocker. Appendix C item 0.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 FALSE UNTIL WO-C6 LANDS. Flipping this is WO-C6's deliverable and
 * nothing else's: it means the witness and the verifier have passed SHARED
 * VECTORS for the canonical preimage, domain separation, tree ordering, root
 * calculation and proof format.
 *
 * Do not flip it to make a test pass. `resolveAttestationBasis()` takes an
 * explicit `vectorsSettled` override so a test can exercise the settled path
 * WITHOUT changing what the estate emits — which is the only reason a test
 * would ever want to.
 */
export const CHECKPOINT_VECTORS_SETTLED = false;

export const CHECKPOINT_BLOCKER_REASON =
  'the witness and the verifier do not pass shared Merkle vectors (canonical preimage, ' +
  'domain separation, tree ordering, root calculation, proof format). Three live ' +
  'constructions disagree and the witness anchors whichever root the caller supplies, ' +
  'so no checkpoint can be claimed settled and every new leaf states `stale`. ' +
  'See docs/wo/2026-09-09-council-implementation.md WO-C6 and Appendix C item 0.';

/* ────────────────────────────────────────────────────────────────────────
 * Quote binding.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Where the freshness nonce came from. §1: "Checkpoint generation requires a
 * freshness nonce originating OUTSIDE the capture box."
 *
 *   'external-authority'  a nonce authority the capture box does not control.
 *   'in-box'              generated by the box being attested. Proves nothing
 *                         about freshness — a replayed quote reproduces it.
 *   'none'                no nonce.
 */
export const NONCE_ORIGINS = ['external-authority', 'in-box', 'none'] as const;
export type NonceOrigin = (typeof NONCE_ORIGINS)[number];

export interface QuoteBinding {
  /** Did the quote chain to a vendor root? (H-5 dispatch said 'verified'.) */
  rootChained: boolean;
  nonceOrigin: NonceOrigin;
  /** Does what the quote covers include THIS emission? */
  coversEmission: boolean;
}

/**
 * A quote binds this emission only when all three hold. Any one missing and
 * the quote describes a machine at some moment, which is not the same claim.
 */
export function quoteBindsThisEmission(q: QuoteBinding | null | undefined): boolean {
  return !!q && q.rootChained && q.nonceOrigin === 'external-authority' && q.coversEmission;
}

/* ────────────────────────────────────────────────────────────────────────
 * The resolver.
 * ──────────────────────────────────────────────────────────────────────── */

export interface BasisInput {
  profile: CaptureProfile;
  enforcement: PlacementEnforcement;
  /** Null when the placement has no attestable compute at all. */
  quote?: QuoteBinding | null;
  /** Test-only override of CHECKPOINT_VECTORS_SETTLED. See its note. */
  vectorsSettled?: boolean;
}

export interface BasisResolution {
  basis: AttestationBasis;
  reason: string;
}

/**
 * ORDER IS THE POINT, and each step is a different fact:
 *
 *  1. desktop → `verified` is unreachable, so the only question left is
 *     whether there is a quote at all;
 *  2. the checkpoint blocker → `stale`, for every profile, because no
 *     checkpoint can be claimed settled by anybody today;
 *  3. no quote at all → `passthrough`. The placement has no attestable
 *     compute; that is a statement about the deployment, not a failure;
 *  4. a quote that does not bind THIS emission → `stale`, never
 *     `passthrough`;
 *  5. bound, root-chained, representable → `verified`.
 */
export function resolveAttestationBasis(input: BasisInput): BasisResolution {
  const settled = input.vectorsSettled ?? CHECKPOINT_VECTORS_SETTLED;
  const hasQuote = !!input.quote;

  if (!verifiedIsRepresentable(input.profile, input.enforcement)) {
    // Step 1. A quote may still exist here and may even be root-chained; it
    // is refused as a basis rather than silently downgraded, and the reason
    // says which of the two conditions failed.
    const why =
      input.profile === 'desktop'
        ? 'the desktop profile: the measured party has root, PCRs attest boot and the ' +
          'threat is runtime, so `verified` is unreachable by construction'
        : `enforcement '${input.enforcement}' does not keep the measured party out of the capture process`;
    if (!settled) {
      return { basis: 'stale', reason: `${why}; and ${CHECKPOINT_BLOCKER_REASON}` };
    }
    return hasQuote
      ? { basis: 'stale', reason: `${why}; a quote is present and cannot be a basis here` }
      : { basis: 'passthrough', reason: why };
  }

  if (!settled) {
    // Step 2. Not folded into step 4: this is not a broken quote, it is a
    // checkpoint nobody can claim settled.
    return { basis: 'stale', reason: CHECKPOINT_BLOCKER_REASON };
  }

  if (!hasQuote) {
    // Step 3.
    return {
      basis: 'passthrough',
      reason:
        'no attestation envelope: the placement has no attestable compute, so the ' +
        'build↔key binding is an assertion and the receipt must read as such (§12.4)',
    };
  }

  if (!quoteBindsThisEmission(input.quote)) {
    // Step 4. THE VALUE THE THIRD STATE EXISTS FOR.
    const q = input.quote!;
    const missing = [
      q.rootChained ? null : 'it does not chain to a vendor root',
      q.nonceOrigin === 'external-authority'
        ? null
        : `its freshness nonce originated ${q.nonceOrigin === 'in-box' ? 'inside the capture box' : 'nowhere'}`,
      q.coversEmission ? null : 'what it covers does not include this emission',
    ].filter(Boolean);
    return {
      basis: 'stale',
      reason:
        `a quote is present but cannot be bound to this emission: ${missing.join('; ')}. ` +
        'Reported as `stale` and NOT as `passthrough` — those are different operational ' +
        'conditions with different fixes.',
    };
  }

  return {
    basis: 'verified',
    reason:
      'root-chained, freshness nonce from an authority outside the capture box, and the ' +
      'quote covers this emission',
  };
}
