// Tenant authentication for the Continuous Audit API.
//
// Every /v1/log/* and /v1/streams request presents a Bearer token in the
// Authorization header. The token is sk_int_<random> or sk_tenant_<random>;
// we look up the tenants row whose api_key_hash equals sha256(bearer_token).
//
// This is DISTINCT from lib/auth/apiKey.ts (which authenticates end-user
// desktop clients like the Fusion plugin against user accounts). Tenant
// keys authenticate multi-tenant witness callers against tenants rows.

import { createHash } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';

export interface TenantRow {
  tenant_id: string;
  name: string;
  api_key_hash: string;
  hmac_secret_enc: string;
  status: string;
  is_internal: number;
  rate_limit_rps: number | null;
  created_at: string;
}

export interface AuthedTenant {
  tenant_id: string;
  is_internal: boolean;
  hmac_secret: string;
  rate_limit_rps: number;
}

const DEFAULT_RATE_LIMIT_RPS = 500;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Look up a tenant by bearer token. Returns null on unknown or suspended /
 * revoked tenants.
 *
 * Sprint 1 stores hmac_secret_enc as plaintext under the sentinel value
 * 'internal' for TEN_scruple, and as plaintext for provisioned tenants
 * (deploy/scripts/provision-c2pa-tenant.sh writes the plaintext directly
 * because Sprint 1 has no KEK yet — WO-17 lifecycle work wraps it in a
 * Vault-held KEK).
 */
export function lookupTenantByBearer(bearer: string): AuthedTenant | null {
  const hash = sha256Hex(bearer);
  const row = conn()
    .prepare(
      `SELECT tenant_id, name, api_key_hash, hmac_secret_enc, status,
              is_internal, rate_limit_rps, created_at
         FROM tenants
        WHERE api_key_hash = ? AND status = 'active'`,
    )
    .get(hash) as TenantRow | undefined;
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    is_internal: row.is_internal === 1,
    hmac_secret: row.hmac_secret_enc, // Sprint 1 plaintext; unwrap in later WO
    rate_limit_rps: row.rate_limit_rps ?? DEFAULT_RATE_LIMIT_RPS,
  };
}

/** Extract the bearer token from an Authorization header. */
export function bearerFromHeader(auth: string | null): string | null {
  if (!auth) return null;
  const m = /^bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}
