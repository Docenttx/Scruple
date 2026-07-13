// Shared ingest checks for baseline_hash + platform_attestation.
//
// Called from every witness ingest route (v1/log, v1/log/batch, and the
// per-app routes) BEFORE the route does its own work. Returns either
// `{ ok: true, ... }` on pass, or `{ ok: false, status, body }` on any
// rejection. Routes translate the rejection into a NextResponse.
//
// Enforcement is CONDITIONAL on the tenant having a baseline. Tenants
// without a baseline (legacy or brand-new) bypass all checks — nothing
// to enforce against. Once a tenant submits a genesis baseline, every
// subsequent leaf MUST carry X-Baseline-Hash matching current and, if
// the baseline declares an attestation provider, a valid envelope.

import { createHash } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { getCurrent, type BaselineRow } from '@/lib/baseline/dao';
import {
  envelopeSchemaValidator,
  EnvelopeValidationError,
  type AttestationEnvelope,
} from '@/packages/scruple-attestation-verifiers/src/envelope';

/** Default per Integration Requirements v1.2 §4.4. */
export const DEFAULT_FRESHNESS_MAX_SECONDS = 15 * 60;
export const MIN_FRESHNESS_MAX_SECONDS = 60;

export interface BaselineCheckOk {
  ok: true;
  baseline: BaselineRow | null; // null when the tenant has no baseline yet
}
export interface BaselineCheckReject {
  ok: false;
  status: number;
  body: {
    error: string;
    code: string;
    current_baseline_hash?: string;
    hint?: string;
  };
}
export type BaselineCheck = BaselineCheckOk | BaselineCheckReject;

/**
 * Enforce the tenant's current-baseline reference against the request's
 * X-Baseline-Hash header. Called first in every ingest handler.
 */
export function enforceBaselineRef(
  tenant_id: string,
  header_value: string | null,
): BaselineCheck {
  const baseline = getCurrent(tenant_id);
  if (!baseline) {
    // Tenant has no baseline — pre-migration or brand-new. Skip enforcement.
    return { ok: true, baseline: null };
  }

  if (!header_value) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'X-Baseline-Hash header required for tenants with active baseline',
        code: 'baseline_required',
        current_baseline_hash: baseline.baseline_hash,
        hint: 'set X-Baseline-Hash to tenant current baseline; re-baseline via POST /rebaseline if drift',
      },
    };
  }
  if (header_value !== baseline.baseline_hash) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'X-Baseline-Hash does not match tenant current baseline',
        code: 'baseline_mismatch',
        current_baseline_hash: baseline.baseline_hash,
        hint: 're-baseline via POST /rebaseline before submitting further leaves',
      },
    };
  }
  return { ok: true, baseline };
}

export interface AttestationCheckOk {
  ok: true;
  envelope: AttestationEnvelope | null;
}
export interface AttestationCheckReject {
  ok: false;
  status: number;
  body: { error: string; code: string };
}
export type AttestationCheck = AttestationCheckOk | AttestationCheckReject;

function tenantFreshnessMaxSeconds(tenant_id: string): number {
  const row = conn()
    .prepare(`SELECT attestation_freshness_max_seconds FROM tenants WHERE tenant_id = ?`)
    .get(tenant_id) as { attestation_freshness_max_seconds: number | null } | undefined;
  const configured = row?.attestation_freshness_max_seconds ?? null;
  if (configured === null) return DEFAULT_FRESHNESS_MAX_SECONDS;
  return Math.max(MIN_FRESHNESS_MAX_SECONDS, configured);
}

/**
 * Enforce platform_attestation shape + freshness + nonce-binding for
 * tenants whose baseline declares a non-`none` attestation provider.
 *
 * `expected_nonce_hex` is SHA-256 of the leaf preimage EXCLUDING the
 * envelope itself. Caller computes this before calling us.
 *
 * NOTE: this WO does NOT run verifier plugins. WO-04 wires dispatch()
 * into a follow-on enforcement step; here we just validate shape,
 * freshness, and nonce binding, and set platform_attestation_verified = 0.
 */
export function enforceAttestation(
  tenant_id: string,
  baseline: BaselineRow | null,
  envelope_raw: unknown,
  expected_nonce_hex: string,
): AttestationCheck {
  if (!baseline || baseline.attestation_provider === 'none') {
    // No attestation required. If one was submitted anyway, ignore silently.
    return { ok: true, envelope: null };
  }

  if (envelope_raw === undefined || envelope_raw === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'platform_attestation required — tenant baseline declares attestation.provider ' +
          baseline.attestation_provider,
        code: 'attestation_required',
      },
    };
  }

  let env: AttestationEnvelope;
  try {
    env = envelopeSchemaValidator(envelope_raw);
  } catch (e) {
    return {
      ok: false,
      status: 400,
      body: {
        error: e instanceof EnvelopeValidationError ? e.message : String(e),
        code: 'attestation_invalid_shape',
      },
    };
  }

  if (env.attestation_type !== baseline.attestation_provider) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          `platform_attestation.attestation_type '${env.attestation_type}' does not match baseline provider '${baseline.attestation_provider}'`,
        code: 'attestation_type_mismatch',
      },
    };
  }

  if (env.nonce !== expected_nonce_hex) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'platform_attestation.nonce does not match SHA-256(leaf preimage)',
        code: 'attestation_nonce_mismatch',
      },
    };
  }

  const maxSec = tenantFreshnessMaxSeconds(tenant_id);
  const ageMs = Date.now() - Date.parse(env.attestation_time);
  if (Number.isNaN(ageMs)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'platform_attestation.attestation_time is not parseable',
        code: 'attestation_time_invalid',
      },
    };
  }
  if (ageMs > maxSec * 1000) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          `platform_attestation is stale — attestation_time is ${Math.floor(ageMs / 1000)}s old; tenant freshness window is ${maxSec}s`,
        code: 'attestation_stale',
      },
    };
  }
  // Reject small negative skew (clock disagreement > 60s in the future) as invalid.
  if (ageMs < -60_000) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'platform_attestation.attestation_time is more than 60s in the future',
        code: 'attestation_future',
      },
    };
  }

  return { ok: true, envelope: env };
}

/**
 * Compute SHA-256 hex over a canonical JSON serialization of the leaf
 * preimage-minus-envelope. Callers provide the object with all fields
 * that participate in the leaf identity EXCEPT platform_attestation.
 *
 * Uses the same canonicalization rules as leaf preimages elsewhere:
 * sorted keys, compact JSON, no whitespace.
 */
export function computeExpectedNonce(preimageWithoutEnvelope: Record<string, unknown>): string {
  const canonical = canonicalize(preimageWithoutEnvelope);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(obj);
}
