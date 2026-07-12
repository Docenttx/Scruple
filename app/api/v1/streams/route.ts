// /v1/streams
//   POST — create or update a stream for the caller's tenant.
//   GET  — list the caller's streams + latest observability metadata.
//
// Auth: Bearer only (no HMAC — config endpoints are rare and audited via
// tenants.last_used_at pattern later).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { conn } from '@/lib/db/sqlite';
import { bearerFromHeader, lookupTenantByBearer } from '@/lib/witness/tenantAuth';
import { newStreamId } from '@/lib/witness/streamIds';

export const dynamic = 'force-dynamic';

const StreamBody = z.object({
  name: z.string().min(1).max(200),
  checkpoint_secs: z.number().int().min(60).default(300),
  tsa_mode: z.enum(['none', 'rfc3161', 'rfc3161_qualified']).default('none'),
  tsa_url: z.string().url().optional(),
  anchor_epoch_secs: z.number().int().min(60).default(3600),
  retention_days: z.number().int().min(1).default(2555),
  principal_mode: z.enum(['none', 'fixed', 'per_leaf']).default('none'),
  fixed_principal: z.string().optional(),
  schema_hint: z.record(z.unknown()).optional(),
});

const RESERVED_PREFIX = /^(?:_scruple\.|scruple\.)/;

export async function POST(req: NextRequest) {
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (!bearer) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const tenant = lookupTenantByBearer(bearer);
  if (!tenant) return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });

  let body: z.infer<typeof StreamBody>;
  try {
    body = StreamBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  if (body.anchor_epoch_secs < body.checkpoint_secs) {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'anchor_epoch_secs must be >= checkpoint_secs' },
      { status: 400 },
    );
  }
  if (!tenant.is_internal && RESERVED_PREFIX.test(body.name)) {
    return NextResponse.json({ error: 'stream_reserved' }, { status: 400 });
  }
  if (body.principal_mode === 'fixed' && !body.fixed_principal) {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'principal_mode=fixed requires fixed_principal' },
      { status: 400 },
    );
  }

  const db = conn();
  const existing = db
    .prepare('SELECT stream_id, principal_mode FROM streams WHERE tenant_id = ? AND name = ?')
    .get(tenant.tenant_id, body.name) as { stream_id: string; principal_mode: string } | undefined;

  if (existing) {
    if (existing.principal_mode !== body.principal_mode) {
      // Check if any leaves exist — if so, principal_mode is now immutable.
      const anyLeaves = db
        .prepare('SELECT 1 FROM log_leaves WHERE stream_id = ? LIMIT 1')
        .get(existing.stream_id);
      if (anyLeaves) {
        return NextResponse.json(
          {
            error: 'invalid_body',
            detail: 'principal_mode cannot change once stream has leaves',
          },
          { status: 400 },
        );
      }
    }
    db.prepare(
      `UPDATE streams SET
         checkpoint_secs = ?, tsa_mode = ?, tsa_url = ?,
         anchor_epoch_secs = ?, retention_days = ?, principal_mode = ?,
         fixed_principal = ?, schema_hint = ?
       WHERE stream_id = ?`,
    ).run(
      body.checkpoint_secs,
      body.tsa_mode,
      body.tsa_url ?? null,
      body.anchor_epoch_secs,
      body.retention_days,
      body.principal_mode,
      body.fixed_principal ?? null,
      body.schema_hint ? JSON.stringify(body.schema_hint) : null,
      existing.stream_id,
    );
    const updated = db
      .prepare('SELECT * FROM streams WHERE stream_id = ?')
      .get(existing.stream_id);
    return NextResponse.json({ stream: updated, updated: true });
  }

  const streamId = newStreamId();
  db.prepare(
    `INSERT INTO streams
       (stream_id, tenant_id, name, checkpoint_secs, tsa_mode, tsa_url,
        anchor_epoch_secs, retention_days, principal_mode, fixed_principal,
        schema_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    streamId,
    tenant.tenant_id,
    body.name,
    body.checkpoint_secs,
    body.tsa_mode,
    body.tsa_url ?? null,
    body.anchor_epoch_secs,
    body.retention_days,
    body.principal_mode,
    body.fixed_principal ?? null,
    body.schema_hint ? JSON.stringify(body.schema_hint) : null,
  );
  const created = db.prepare('SELECT * FROM streams WHERE stream_id = ?').get(streamId);
  return NextResponse.json({ stream: created, created: true });
}

export async function GET(req: NextRequest) {
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (!bearer) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const tenant = lookupTenantByBearer(bearer);
  if (!tenant) return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });

  const streams = conn()
    .prepare(
      `SELECT s.*,
              (SELECT MAX(tenant_seq)  FROM log_leaves WHERE stream_id = s.stream_id) AS latest_leaf_seq,
              (SELECT MAX(received_at) FROM log_leaves WHERE stream_id = s.stream_id) AS latest_leaf_received_at,
              (SELECT MAX(epoch_index) FROM log_checkpoints WHERE stream_id = s.stream_id) AS latest_checkpoint_epoch,
              (SELECT MAX(created_at)  FROM log_checkpoints WHERE stream_id = s.stream_id) AS latest_checkpoint_at
         FROM streams s
        WHERE s.tenant_id = ?
        ORDER BY s.created_at DESC`,
    )
    .all(tenant.tenant_id);

  return NextResponse.json({ streams });
}
