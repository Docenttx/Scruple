// POST /api/lock/checkpoint
//
// Soft-lock that preserves progress without sealing. Computes a Merkle
// root snapshot AND keeps the project unlocked for further iterations.
// Mirrors desktop's "Checkpoint" mode (vs Finalize / Chain Lock).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { buildMerkle } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import type { ProjectRow, IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Body = z.object({ projectId: z.number().int().positive() });

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = Body.parse(await req.json());
  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  if (project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json({ error: `Project is ${project.status}` }, { status: 409 });
  }

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(body.projectId) as IterationRow[];
  if (iterations.length === 0) {
    return NextResponse.json({ error: 'No iterations to checkpoint' }, { status: 400 });
  }

  const tree = buildMerkle(iterations.map((i) => i.leaf_hash));
  if (!tree.root) return NextResponse.json({ error: 'Merkle root failed' }, { status: 500 });

  const preScr = deriveScrId(tree.root, false);
  const now = new Date().toISOString();

  const tx = conn().transaction(() => {
    conn().prepare(`DELETE FROM merkle_nodes WHERE project_id = ?`).run(body.projectId);
    const insertNode = conn().prepare(
      `INSERT INTO merkle_nodes (project_id, level, position, hash, left_child_hash, right_child_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const n of tree.nodes) {
      insertNode.run(body.projectId, n.level, n.position, n.hash, n.leftChildHash, n.rightChildHash);
    }
    conn()
      .prepare(
        `UPDATE projects SET status = 'checkpointed', merkle_root = ?, pre_scr_id = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(tree.root, preScr, now, body.projectId);
  });
  tx();

  return NextResponse.json({ ok: true, preScrId: preScr, merkleRoot: tree.root, leafCount: tree.leafCount });
}
