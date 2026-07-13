// GET /api/v1/tenants/[tenant]/baseline/history — full chain, most recent first.
//
// Query params:
//   limit   integer, default 50, max 200
//   before  hex baseline_hash cursor — return rows activated STRICTLY
//           before this baseline's activation timestamp

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { getHistory } from '@/lib/baseline/dao';

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

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const before = url.searchParams.get('before') ?? undefined;
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return NextResponse.json(
        { error: "'limit' MUST be an integer 1..200", code: 'invalid_query' },
        { status: 400 },
      );
    }
    limit = parsed;
  }
  if (before !== undefined && !/^[0-9a-f]{64}$/.test(before)) {
    return NextResponse.json(
      { error: "'before' MUST be a 64-hex baseline_hash cursor", code: 'invalid_query' },
      { status: 400 },
    );
  }

  const rows = getHistory(tenant.tenant_id, { limit, before });
  return NextResponse.json({
    baselines: rows.map((r) => ({
      baseline_hash: r.baseline_hash,
      prev_baseline_hash: r.prev_baseline_hash,
      activated_at: r.activated_at,
      retired_at: r.retired_at,
      reason: r.reason,
      attestation_provider: r.attestation_provider,
    })),
  });
}
