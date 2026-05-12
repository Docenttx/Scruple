// POST /api/audit/iteration/:id — Manual tamper-audit of one iteration.
// GET  /api/audit/iteration/:id — Read the audit history (most-recent
//                                 first, last 10 entries).
//
// Per-iteration on-demand verification. Re-fetches the bytes from the
// user's storage provider, SHA-256s them, compares to the recorded
// leaf_hash, logs to tamper_audit_log.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { auditIteration, getAuditSummary } from '@/lib/audit/tamper';

export const dynamic = 'force-dynamic';

async function checkOwnership(iterationId: number, userId: string): Promise<boolean> {
  const row = conn()
    .prepare(
      `SELECT p.user_id AS owner FROM iterations i
         JOIN projects p ON p.id = i.project_id
         WHERE i.id = ?`,
    )
    .get(iterationId) as { owner: string } | undefined;
  return row?.owner === userId;
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  if (!(await checkOwnership(id, userId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = await auditIteration(id);
  return NextResponse.json(result);
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  if (!(await checkOwnership(id, userId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const summary = getAuditSummary(id);
  return NextResponse.json(summary ?? { error: 'Not found' });
}
