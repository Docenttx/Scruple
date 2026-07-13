// GET /api/v1/registry/baselines/[tenant]/verify/[hash]
//
// Returns whether the specific baseline_hash is / was ever active for
// the tenant, and its activation window. Public; tenant must have
// opted into public baseline anchoring.

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

interface BaselineRow {
  baseline_hash: string;
  prev_baseline_hash: string | null;
  activated_at: string;
  retired_at: string | null;
}

function isPublic(tenant_id: string): boolean {
  const row = conn()
    .prepare(`SELECT publish_baseline_publicly FROM tenants WHERE tenant_id = ?`)
    .get(tenant_id) as { publish_baseline_publicly: number } | undefined;
  return row?.publish_baseline_publicly === 1;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { tenant: string; hash: string } },
) {
  if (!/^[0-9a-f]{64}$/.test(params.hash)) {
    return NextResponse.json({ error: 'hash MUST be 64 hex chars', code: 'invalid_hash' }, { status: 400 });
  }
  if (!isPublic(params.tenant)) {
    return NextResponse.json(
      { error: 'tenant not registered for public baseline transparency', code: 'not_public' },
      { status: 404 },
    );
  }
  const row = conn()
    .prepare(
      `SELECT baseline_hash, prev_baseline_hash, activated_at, retired_at
         FROM baselines WHERE tenant_id = ? AND baseline_hash = ?`,
    )
    .get(params.tenant, params.hash) as BaselineRow | undefined;
  if (!row) {
    return NextResponse.json({
      known: false,
      tenant_id: params.tenant,
      baseline_hash: params.hash,
    });
  }
  return NextResponse.json({
    known: true,
    tenant_id: params.tenant,
    baseline_hash: row.baseline_hash,
    prev_baseline_hash: row.prev_baseline_hash,
    activated_at: row.activated_at,
    retired_at: row.retired_at,
    active_now: row.retired_at === null,
  });
}
