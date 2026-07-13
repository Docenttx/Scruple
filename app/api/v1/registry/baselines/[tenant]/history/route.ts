// GET /api/v1/registry/baselines/[tenant]/history — public baseline history

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import { getHistory } from '@/lib/baseline/dao';

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
  const rows = getHistory(params.tenant, { limit: 200 });
  return NextResponse.json({
    tenant_id: params.tenant,
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
