// GET /api/v1/tenants/[tenant]/baseline/current

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { getCurrent } from '@/lib/baseline/dao';

export const dynamic = 'force-dynamic';

export async function GET(
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

  const row = getCurrent(tenant.tenant_id);
  if (!row) {
    return NextResponse.json({ error: 'no baseline yet', code: 'no_baseline' }, { status: 404 });
  }
  return NextResponse.json({
    baseline_hash: row.baseline_hash,
    prev_baseline_hash: row.prev_baseline_hash,
    activated_at: row.activated_at,
    attestation_provider: row.attestation_provider,
    signer_pubkey_spki_sha256_hex: row.signer_pubkey_spki_sha256_hex,
  });
}
