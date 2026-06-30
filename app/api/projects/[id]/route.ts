// GET /api/projects/[id] → project row + iterations (lightweight) for clients.
//
// The Fusion add-in polls this every 30s to refresh the iteration counter
// and lock status. Ownership-gated by user_id.
//
// Auth: NextAuth cookie OR Authorization: Bearer <api_key>.

import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';
import type { IterationRow, ProjectRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = Number(params.id);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, me.id) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const iterations = conn()
    .prepare(
      `SELECT id, project_id, run_sequence, prompt, output_hash, leaf_hash,
              input_hash, workflow_hash, machine_manifest_hash,
              timestamp, witnessed, witness_timestamp,
              previous_hash, output_kind
       FROM iterations
       WHERE project_id = ?
       ORDER BY run_sequence ASC`,
    )
    .all(projectId) as IterationRow[];

  return NextResponse.json({
    project,
    iterations,
    iterationCount: iterations.length,
  });
}
