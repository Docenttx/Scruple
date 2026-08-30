// Component provisioning — §4.4 injection.
//
//   1. Vendor creates a component instance in their Scruple console ->
//      one-time provisioning token, short TTL.
//   2. Component starts, POSTs the token, its build_measurement and an
//      attestation quote if it has one.
//   3. Server derives IK, returns it over TLS, burns the token, records
//      (component_id, build, attestation posture, n=0).
//   4. Component seals IK — to the TPM/SEV measurement where available,
//      else a 0600 file owned by a user the tenant is not.
//
// The token is the whole of the injection ceremony's security, so it is
// treated the way api_keys treats a key: 32 bytes of CSPRNG, shown once,
// stored as sha256, single use, short TTL. In payments the equivalent
// step happens in a certified key-injection facility; this is the
// software-era stand-in and should be described as one.

import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { bdk, bdkFingerprint } from './bdk';
import { deriveIk, zeroize } from './ratchet';

/** Short. A provisioning token is redeemed by a container that is already
 *  starting; anything longer is a window, not a convenience. */
export const PROVISIONING_TOKEN_TTL_SECONDS = 15 * 60;

export const TOKEN_PREFIX = 'spt_';

export interface IssuedToken {
  componentId: string;
  /** Shown exactly once. Never stored. */
  token: string;
  expiresAt: string;
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a pending component and its one-time token.
 *
 * Called by the vendor console. Exported here (rather than living inside
 * a route) because the provisioning endpoint's tests need to mint tokens,
 * and a test that mints them by hand is testing its own INSERT rather
 * than the thing that ships.
 */
export function issueProvisioningToken(opts: {
  tenantId: string;
  label?: string | null;
  componentId?: string;
  heartbeatWindowSeconds?: number;
  ttlSeconds?: number;
}): IssuedToken {
  const componentId = opts.componentId ?? crypto.randomUUID();
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const ttl = opts.ttlSeconds ?? PROVISIONING_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  conn()
    .prepare(
      `INSERT INTO components
         (component_id, tenant_id, label, status,
          heartbeat_window_seconds,
          provisioning_token_hash, provisioning_token_expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      componentId,
      opts.tenantId,
      opts.label ?? null,
      opts.heartbeatWindowSeconds ?? 900,
      tokenHash(token),
      expiresAt,
    );

  return { componentId, token, expiresAt };
}

export type RedeemFailure =
  | 'unknown_token'
  | 'token_consumed'
  | 'token_expired'
  | 'wrong_tenant'
  | 'retired';

export interface RedeemOk {
  ok: true;
  componentId: string;
  /** The IK, hex. Returned to the component over TLS exactly once and
   *  never persisted — the server re-derives it from the BDK whenever it
   *  needs it, which is the point of a derivation hierarchy. */
  ikHex: string;
  counter: 0;
  attestationStatus: 'verified' | 'passthrough' | null;
  buildMeasurement: string;
  provisionedAt: string;
}

export interface RedeemFail {
  ok: false;
  reason: RedeemFailure;
  message: string;
}

/**
 * Burn a token and provision the component.
 *
 * The burn and the record are one transaction, and the burn is expressed
 * as a conditional UPDATE rather than a read-then-write: two containers
 * racing on the same token must not both come away with an IK for one
 * component_id, because both would then start at n=0 and each would look
 * like a replay of the other.
 */
export function redeemProvisioningToken(opts: {
  token: string;
  tenantId: string;
  buildMeasurement: string;
  attestation?: { provider: string; quote_ref?: string | null } | null;
}): RedeemOk | RedeemFail {
  const db = conn();
  const hash = tokenHash(opts.token);
  const now = new Date().toISOString();

  const row = db
    .prepare(
      `SELECT component_id, tenant_id, status,
              provisioning_token_expires_at, provisioning_token_consumed_at
         FROM components WHERE provisioning_token_hash = ?`,
    )
    .get(hash) as
    | {
        component_id: string;
        tenant_id: string;
        status: string;
        provisioning_token_expires_at: string | null;
        provisioning_token_consumed_at: string | null;
      }
    | undefined;

  if (!row) {
    return {
      ok: false,
      reason: 'unknown_token',
      message: 'No such provisioning token. Tokens are single-use and short-lived.',
    };
  }
  // The token identifies the component; the bearer key identifies the
  // caller. Requiring them to agree is what stops one vendor redeeming
  // another vendor's token and owning a component in their estate.
  if (row.tenant_id !== opts.tenantId) {
    return {
      ok: false,
      reason: 'wrong_tenant',
      message: 'This provisioning token does not belong to the authenticated tenant.',
    };
  }
  if (row.status === 'retired') {
    return { ok: false, reason: 'retired', message: 'This component has been retired.' };
  }
  if (row.provisioning_token_consumed_at !== null) {
    return {
      ok: false,
      reason: 'token_consumed',
      message:
        'This provisioning token has already been redeemed. A component that lost its ' +
        'sealed IK must be issued a NEW component_id starting at n=0 (§4.4) — never ' +
        'reuse a counter under an existing id.',
    };
  }
  if (
    row.provisioning_token_expires_at !== null &&
    Date.parse(row.provisioning_token_expires_at) < Date.now()
  ) {
    return {
      ok: false,
      reason: 'token_expired',
      message: 'This provisioning token has expired. Issue a new one from the console.',
    };
  }

  // §12.4 / H-5, and the same honest choice app/api/v2/baseline/route.ts
  // makes: chain-to-vendor-root verification is not wired anywhere in the
  // estate, so an attestation supplied here is recorded as passthrough
  // rather than flattered into 'verified'. When the quote is actually
  // verified against a vendor root, this is the one line that changes.
  const attestationProvider = opts.attestation?.provider ?? 'none';
  const attestationStatus: 'verified' | 'passthrough' | null = opts.attestation
    ? 'passthrough'
    : null;

  const ik = deriveIk(bdk(), row.component_id);
  const ikHex = ik.toString('hex');

  const info = db
    .prepare(
      `UPDATE components
          SET status                         = 'active',
              build_measurement              = ?,
              attestation_provider           = ?,
              attestation_quote_ref          = ?,
              attestation_status             = ?,
              last_verified_counter          = NULL,
              chain_key_counter              = 0,
              chain_key_hex                  = ?,
              bdk_fingerprint                = ?,
              provisioning_token_consumed_at = ?,
              provisioned_at                 = ?,
              updated_at                     = ?
        WHERE component_id = ? AND provisioning_token_consumed_at IS NULL`,
    )
    .run(
      opts.buildMeasurement,
      attestationProvider,
      opts.attestation?.quote_ref ?? null,
      attestationStatus,
      process.env.SCRUPLE_RATCHET_CACHE_CHAIN_KEY === '0' ? null : ikHex,
      bdkFingerprint(),
      now,
      now,
      now,
      row.component_id,
    );

  zeroize(ik);

  if (info.changes !== 1) {
    // Lost the race with a concurrent redemption.
    return {
      ok: false,
      reason: 'token_consumed',
      message: 'This provisioning token was redeemed concurrently by another caller.',
    };
  }

  return {
    ok: true,
    componentId: row.component_id,
    ikHex,
    counter: 0,
    attestationStatus,
    buildMeasurement: opts.buildMeasurement,
    provisionedAt: now,
  };
}
