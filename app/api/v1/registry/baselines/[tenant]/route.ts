// GET /api/v1/registry/baselines/[tenant]
//
// Public (unauthenticated) baseline registry endpoint. Returns the
// current baseline for the tenant IF the tenant has opted into public
// baseline anchoring (tenants.publish_baseline_publicly = 1).
//
// Per Standard v1.2 §4 (Public ledger anchoring as transparency option).

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import { getCurrent } from '@/lib/baseline/dao';

export const dynamic = 'force-dynamic';

function isPublic(tenant_id: string): boolean {
  const row = conn()
    .prepare(`SELECT publish_baseline_publicly FROM tenants WHERE tenant_id = ?`)
    .get(tenant_id) as { publish_baseline_publicly: number } | undefined;
  return row?.publish_baseline_publicly === 1;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { tenant: string } },
) {
  if (!isPublic(params.tenant)) {
    return NextResponse.json(
      { error: 'tenant not registered for public baseline transparency', code: 'not_public' },
      { status: 404 },
    );
  }
  const current = getCurrent(params.tenant);
  if (!current) {
    return NextResponse.json({ error: 'no baseline yet', code: 'no_baseline' }, { status: 404 });
  }
  return NextResponse.json({
    tenant_id: params.tenant,
    baseline_hash: current.baseline_hash,
    prev_baseline_hash: current.prev_baseline_hash,
    activated_at: current.activated_at,
    attestation_provider: current.attestation_provider,
  });
}
