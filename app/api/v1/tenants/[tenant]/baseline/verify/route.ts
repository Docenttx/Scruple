// POST /api/v1/tenants/[tenant]/baseline/verify — is this hash current?
//
// Fast check for the SDK to self-verify before submitting a witness call.

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { verifyMatchesCurrent } from '@/lib/baseline/dao';

export const dynamic = 'force-dynamic';

interface Body {
  candidate_hash_hex: string;
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
  if (typeof body.candidate_hash_hex !== 'string' || !/^[0-9a-f]{64}$/.test(body.candidate_hash_hex)) {
    return NextResponse.json(
      { error: "'candidate_hash_hex' MUST be 64 hex chars", code: 'invalid_body' },
      { status: 400 },
    );
  }

  const result = verifyMatchesCurrent(tenant.tenant_id, body.candidate_hash_hex);
  return NextResponse.json(result);
}
