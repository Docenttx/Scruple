// POST /v1/log/{stream_name} — single-leaf ingest.
//
// Auth: Bearer token (tenant API key) + X-Scruple-Timestamp +
//       X-Scruple-Signature (HMAC-SHA256 over `${timestamp}\n${raw_body}`
//       with tenant HMAC secret). See lib/witness/hmacMiddleware.ts.
//
// See docs/wo/2026-07-12-witnessing-l2/WO-06-audit-api-ingest.md.

import { NextRequest, NextResponse } from 'next/server';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { extractHmacHeaders, verifyHmac } from '@/lib/witness/hmacMiddleware';
import { tryConsume } from '@/lib/witness/rateLimit';
import { ingestLeaf } from '@/lib/witness/ingest';
import {
  enforceBaselineRef,
  enforceAttestation,
  computeExpectedNonce,
} from '@/lib/baseline/ingest_check';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { stream_name: string } },
) {
  // Auth
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (!bearer) {
    return NextResponse.json(
      { error: 'missing bearer', code: 'unknown_key' },
      { status: 401 },
    );
  }
  const tenant = lookupTenantByBearer(bearer);
  if (!tenant) {
    return NextResponse.json(
      { error: 'invalid bearer', code: 'unknown_key' },
      { status: 401 },
    );
  }

  // Raw body — MUST read once as text so the HMAC covers the same bytes
  // we parse.
  const rawBody = await req.text();

  // HMAC
  const verdict = verifyHmac(extractHmacHeaders(req), rawBody, tenant.hmac_secret);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: 'hmac ' + verdict.reason, code: verdict.reason },
      { status: 401 },
    );
  }

  // Rate limit — single leaf = 1 slot.
  const rl = tryConsume(tenant.tenant_id, 1, tenant.rate_limit_rps);
  if (!rl.allowed) {
    return new NextResponse(
      JSON.stringify({ error: 'rate_limited' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfterSecs) } },
    );
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_json', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  // Baseline enforcement (WO-03). Skipped when the tenant has no baseline.
  const baselineCheck = enforceBaselineRef(tenant.tenant_id, req.headers.get('x-baseline-hash'));
  if (!baselineCheck.ok) {
    return NextResponse.json(baselineCheck.body, { status: baselineCheck.status });
  }

  // Attestation enforcement (WO-03). Requires the leaf preimage minus the
  // envelope so we can compute the expected nonce = sha256(preimage). We
  // build a canonical view of the incoming leaf fields excluding
  // `platform_attestation`.
  const { platform_attestation: envelopeRaw, ...bodyWithoutEnvelope } = body as Record<string, unknown>;
  const expectedNonce = computeExpectedNonce(bodyWithoutEnvelope);
  const attCheck = await enforceAttestation(
    tenant.tenant_id,
    baselineCheck.baseline,
    envelopeRaw ?? null,
    expectedNonce,
  );
  if (!attCheck.ok) {
    return NextResponse.json(attCheck.body, { status: attCheck.status });
  }

  // Ingest
  const result = ingestLeaf(tenant, params.stream_name, bodyWithoutEnvelope as never);
  if (!result.ok) {
    const status = result.code === 'stream_not_found'
      ? 404
      : result.code === 'seq_replay'
        ? 409
        : result.code === 'delegation_inactive' || result.code === 'delegation_required'
          ? 401
          : 400;
    return NextResponse.json({ error: result.code, detail: result.detail, latest_seq: result.latest_seq }, { status });
  }

  return NextResponse.json({
    leaf: {
      stream_id: result.stream_id,
      tenant_seq: result.tenant_seq,
      leaf_hash: `sha256:${result.leaf_hash}`,
      chain_hash: `sha256:${result.chain_hash}`,
      leaf_scheme: result.leaf_scheme,
      pending_checkpoint_epoch: result.pending_checkpoint_epoch,
    },
    ...(result.duplicate ? { duplicate: true } : {}),
    ...(result.gap ? { gap: true, gap_from: result.gap_from } : {}),
  });
}
