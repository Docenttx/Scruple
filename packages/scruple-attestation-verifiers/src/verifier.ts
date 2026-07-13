// Verifier plugin interface. Every attestation type ships a plugin
// implementing this interface; both the server API (ingest verification)
// and the reference verifier CLI import the same plugin implementations.

import type { AttestationEnvelope } from './envelope.js';

export interface VerifyResult {
  /**
   * True if the attestation verified end-to-end (built-in types) OR the
   * envelope is a valid passthrough with `verifier_reference`. False
   * indicates a hard verification failure — the leaf MUST be rejected.
   */
  ok: boolean;

  /** The attestation type this result covers. Copied from envelope for convenience. */
  provider: string;

  /**
   * True when the envelope was accepted as a passthrough (stored, not
   * verified server-side). Distinct from `ok: true` after a full verify.
   */
  passthrough?: boolean;

  /** Present on passthrough results. */
  verifier_reference?: string;

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

export function verifySuccess(
  provider: string,
  extra: Omit<VerifyResult, 'ok' | 'provider'> = {},
): VerifyResult {
  return { ok: true, provider, ...extra };
}
