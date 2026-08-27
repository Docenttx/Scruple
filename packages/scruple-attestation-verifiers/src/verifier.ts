// Verifier plugin interface. Every attestation type ships a plugin
// implementing this interface; both the server API (ingest verification)
// and the reference verifier CLI import the same plugin implementations.

import type { AttestationEnvelope } from './envelope.js';

/**
 * The two states Standard §12.4 makes receipt-visible.
 *
 *   'verified'    — chained to the VENDOR ROOT, nonce matched the leaf,
 *                   within the freshness window. All three, or it is not
 *                   this.
 *   'passthrough' — stored and anchored opaquely. Downstream verification
 *                   is the receipt-consumer's responsibility, and the
 *                   receipt must say so.
 *
 * There is no third value, and deliberately no default. §12.4: "A
 * passthrough attestation MUST NOT present identically to a root-verified
 * one. 'Stored' MUST NOT read as 'verified.'"
 *
 * A structural check that parses a report, matches the nonce and reads
 * the cert subjects — but never chains a signature to the vendor root —
 * is NOT 'verified'. By the Standard's own definition it is
 * indistinguishable from stored, so it is 'passthrough'. Every built-in
 * plugin in this package is in that position today.
 */
export type AttestationStatus = 'verified' | 'passthrough';

export interface VerifyResult {
  /**
   * True if the attestation was accepted (either state above). False
   * indicates a hard verification failure — the leaf MUST be rejected.
   *
   * `ok` ALONE IS NOT A VERIFICATION CLAIM. Read `status`. This field
   * previously carried the whole answer, with the caveat tucked into an
   * optional `benign_codes` array, so every consumer that checked `ok`
   * saw a root-verified attestation where none existed.
   */
  ok: boolean;

  /** Required whenever ok is true. See AttestationStatus. */
  status?: AttestationStatus;

  /** The attestation type this result covers. Copied from envelope for convenience. */
  provider: string;

  /**
   * @deprecated Read `status === 'passthrough'` instead. Kept so existing
   * consumers do not silently change meaning; it is set consistently with
   * `status`.
   */
  passthrough?: boolean;

  /** Present on passthrough results — the reason, shown on the receipt. */
  verifier_reference?: string;

  /** Present ONLY on status:'verified'. The root actually chained to. */
  root_subject?: string;
  /** Present ONLY on status:'verified'. */
  chain_length?: number;

  /** Extracted from the attestation body when available. */
  cvm_measurement_hex?: string;
  chip_id?: string;
  gpu_id?: string;
  driver_version?: string;
  vbios_version?: string;
  pcr_0?: string;
  pcr_digest?: string;
  module_id?: string;
  tcb_status?: string;

  /** Human-readable failure reason when `ok: false`. */
  error?: string;

  /**
   * Codes emitted by the underlying verifier that are tolerated (e.g.
   * dev-CA-untrusted during local development). Present on `ok: true`
   * results that had non-fatal issues.
   */
  benign_codes?: string[];
}

export interface VerifierPlugin {
  /** Value matched against envelope.attestation_type at dispatch time. */
  attestation_type: string;

  /**
   * Verify the envelope end-to-end against its associated leaf preimage
   * hash (expected in the envelope's `nonce` field).
   *
   * MUST return `ok: false` (never throw) on any verification failure,
   * populating `error` with a human-readable diagnostic. Throw only on
   * programmer errors (malformed plugin config, unreachable branches).
   */
  verify(
    env: AttestationEnvelope,
    expected_nonce_hex: string,
    freshness_max_seconds: number,
  ): Promise<VerifyResult>;
}

/**
 * Convenience factory for common failure results.
 */
export function verifyFailure(provider: string, error: string): VerifyResult {
  return { ok: false, provider, error };
}

/**
 * A root-verified attestation.
 *
 * Call this ONLY when the signature chain has been verified to the
 * vendor root. No plugin in this package can call it yet — none
 * implements root chaining — and that is why it takes a `rootProof`
 * argument it cannot be fudged into: whoever wires up real chaining has
 * to produce evidence of what they chained to.
 */
export function verifyRootVerified(
  provider: string,
  rootProof: { root_subject: string; chain_length: number },
  extra: Omit<VerifyResult, 'ok' | 'provider' | 'status' | 'passthrough'> = {},
): VerifyResult {
  return {
    ok: true,
    status: 'verified',
    passthrough: false,
    provider,
    root_subject: rootProof.root_subject,
    chain_length: rootProof.chain_length,
    ...extra,
  };
}

/**
 * An attestation that was accepted but NOT verified to a vendor root.
 *
 * `reason` is not decoration. It reaches the receipt, where §12.4
 * requires a reader to be able to tell this from a real verification.
 */
export function verifyPassthrough(
  provider: string,
  reason: string,
  extra: Omit<VerifyResult, 'ok' | 'provider' | 'status' | 'passthrough'> = {},
): VerifyResult {
  return {
    ok: true,
    status: 'passthrough',
    passthrough: true,
    provider,
    verifier_reference: reason,
    ...extra,
  };
}
