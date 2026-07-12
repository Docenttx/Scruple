// POST /v1/log/{stream_name}/batch — batch-leaf ingest, up to 1000 leaves.
//
// Same auth as the single-leaf route (bearer + HMAC over raw body).
// Server iterates the batch sequentially, running the same contiguity +
// idempotency + delegation checks per leaf. Partial success is expected
// and reported per-item; the HTTP status is 200 for any well-formed batch.

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { extractHmacHeaders, verifyHmac } from '@/lib/witness/hmacMiddleware';
import { tryConsume } from '@/lib/witness/rateLimit';
import { ingestLeaf, type IngestResult, type LeafInput } from '@/lib/witness/ingest';

export const dynamic = 'force-dynamic';

const MAX_BATCH = 1000;

export async function POST(
  req: NextRequest,
  { params }: { params: { stream_name: string } },
) {
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (!bearer) return NextResponse.json({ error: 'missing bearer', code: 'unknown_key' }, { status: 401 });
  const tenant = lookupTenantByBearer(bearer);
  if (!tenant) return NextResponse.json({ error: 'invalid bearer', code: 'unknown_key' }, { status: 401 });

  const rawBody = await req.text();
  const verdict = verifyHmac(extractHmacHeaders(req), rawBody, tenant.hmac_secret);
  if (!verdict.ok) {
    return NextResponse.json({ error: 'hmac ' + verdict.reason, code: verdict.reason }, { status: 401 });
  }

  let body: { leaves?: LeafInput[] };
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_json', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  const leaves = body.leaves;
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return NextResponse.json({ error: 'leaves must be non-empty array' }, { status: 400 });
  }
  if (leaves.length > MAX_BATCH) {
    return NextResponse.json({ error: `batch exceeds ${MAX_BATCH}` }, { status: 400 });
  }

  const rl = tryConsume(tenant.tenant_id, leaves.length, tenant.rate_limit_rps);
  if (!rl.allowed) {
    return new NextResponse(
      JSON.stringify({ error: 'rate_limited', batch_size: leaves.length }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSecs) } },
    );
  }

  const results: Array<
    | { leaf: { stream_id: string; tenant_seq: number; leaf_hash: string; chain_hash: string; pending_checkpoint_epoch: number }; duplicate?: true; gap?: true; gap_from?: number }
    | { error: string; detail?: string; tenant_seq: number; latest_seq?: number }
  > = [];

  for (const input of leaves) {
    const r: IngestResult = ingestLeaf(tenant, params.stream_name, input);
    if (r.ok) {
      results.push({
        leaf: {
          stream_id: r.stream_id,
          tenant_seq: r.tenant_seq,
          leaf_hash: `sha256:${r.leaf_hash}`,
          chain_hash: `sha256:${r.chain_hash}`,
          pending_checkpoint_epoch: r.pending_checkpoint_epoch,
        },
        ...(r.duplicate ? { duplicate: true as const } : {}),
        ...(r.gap ? { gap: true as const, gap_from: r.gap_from } : {}),
      });
    } else {
      results.push({
        error: r.code,
        detail: r.detail,
        tenant_seq: input.tenant_seq,
        latest_seq: r.latest_seq,
      });
    }
  }

  return NextResponse.json({ results });
}
