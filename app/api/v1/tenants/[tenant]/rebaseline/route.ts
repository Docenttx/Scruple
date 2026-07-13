// POST /api/v1/tenants/[tenant]/rebaseline — supersede current baseline.
//
// Rejects 400 if prev_baseline_hash doesn't match current; 404 if tenant
// has no current baseline yet. Chain integrity: server verifies
// prev-hash inside the DAO's insert transaction.

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { BaselineConflictError, insertRebaseline } from '@/lib/baseline/dao';

export const dynamic = 'force-dynamic';

interface Body {
  manifest: unknown;
  manifest_hash_hex: string;
  prev_baseline_hash: string;
  signer_pubkey_spki_sha256_hex: string;
  attestation: { attestation_type?: string } | null;
  reason: string;
  submitted_at: string;
}

function isHex64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { tenant: string } },
) {
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (!bearer) {
    return NextResponse.json({ error: 'missing bearer', code: 'unknown_key' }, { status: 401 });
  }
  const tenant = lookupTenantByBearer(bearer);
  if (!tenant) {
    return NextResponse.json({ error: 'invalid bearer', code: 'unknown_key' }, { status: 401 });
  }
  if (tenant.tenant_id !== params.tenant) {
    return NextResponse.json(
      { error: 'tenant path segment does not match bearer', code: 'tenant_mismatch' },
      { status: 403 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json', code: 'invalid_body' }, { status: 400 });
  }

  if (typeof body.manifest !== 'object' || body.manifest === null) {
    return NextResponse.json({ error: "'manifest' MUST be an object", code: 'invalid_body' }, { status: 400 });
  }
  if (!isHex64(body.manifest_hash_hex)) {
    return NextResponse.json(
      { error: "'manifest_hash_hex' MUST be 64 hex chars", code: 'invalid_body' },
      { status: 400 },
    );
  }
  if (!isHex64(body.prev_baseline_hash)) {
    return NextResponse.json(
      { error: "'prev_baseline_hash' MUST be 64 hex chars", code: 'invalid_body' },
      { status: 400 },
    );
  }
  if (!isHex64(body.signer_pubkey_spki_sha256_hex)) {
    return NextResponse.json(
      { error: "'signer_pubkey_spki_sha256_hex' MUST be 64 hex chars", code: 'invalid_body' },
      { status: 400 },
    );
  }
  if (typeof body.reason !== 'string' || body.reason.length === 0 || body.reason.length > 500) {
    return NextResponse.json(
      { error: "'reason' MUST be a non-empty string (max 500 chars)", code: 'invalid_body' },
      { status: 400 },
    );
  }
  if (typeof body.submitted_at !== 'string' || Number.isNaN(Date.parse(body.submitted_at))) {
    return NextResponse.json(
      { error: "'submitted_at' MUST be an RFC 3339 date-time", code: 'invalid_body' },
      { status: 400 },
    );
  }

  const attestation_provider = body.attestation?.attestation_type ?? 'none';
  const attestation_envelope_json =
    body.attestation && attestation_provider !== 'none' ? JSON.stringify(body.attestation) : null;

  try {
    const result = insertRebaseline({
      tenant_id: tenant.tenant_id,
      baseline_hash: body.manifest_hash_hex,
      prev_baseline_hash: body.prev_baseline_hash,
      manifest_json: JSON.stringify(body.manifest),
      attestation_provider,
      attestation_envelope_json,
      signer_pubkey_spki_sha256_hex: body.signer_pubkey_spki_sha256_hex,
      reason: body.reason,
      submitted_at: body.submitted_at,
    });
    return NextResponse.json({
      baseline_id: result.baseline_id,
      baseline_hash: body.manifest_hash_hex,
      activated_at: result.activated_at,
      witness_leaf_id: null,
    });
  } catch (e) {
    if (e instanceof BaselineConflictError) {
      if (e.code === 'no_baseline') {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
      }
      if (e.code === 'prev_hash_mismatch') {
        return NextResponse.json(
          {
            error: e.message,
            code: e.code,
            current_baseline_hash: e.current_baseline_hash,
          },
          { status: 400 },
        );
      }
      if (e.code === 'duplicate_hash') {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
      }
    }
    throw e;
  }
}
