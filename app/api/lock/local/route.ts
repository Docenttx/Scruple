// POST /api/lock/local
//
// Free local-disc lock. Builds Merkle over all project iterations,
// derives SCR-ID, persists root + nodes + status transition. Atomic.
//
// Body: { projectId: number }
// Response: { ok: true, scrId, merkleRoot, leafCount }

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

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid body', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  if (project.status === 'local_locked' || project.status === 'chain_locked' ||
      project.status === 'persistent_locked' || project.status === 'permanent_locked') {
    return NextResponse.json({ error: `Project is already ${project.status}` }, { status: 409 });
  }

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(body.projectId) as IterationRow[];

  if (iterations.length === 0) {
    return NextResponse.json({ error: 'No iterations to lock' }, { status: 400 });
  }

  const leaves = iterations.map((i) => i.leaf_hash);
  const tree = buildMerkle(leaves);
  if (!tree.root) return NextResponse.json({ error: 'Merkle root computation failed' }, { status: 500 });

  const scrId = deriveScrId(tree.root, false);
  const now = new Date().toISOString();

  const tx = conn().transaction(() => {
    // Wipe any prior merkle nodes (e.g. checkpoint → finalize)
    conn().prepare(`DELETE FROM merkle_nodes WHERE project_id = ?`).run(body.projectId);

    const insertNode = conn().prepare(
      `INSERT INTO merkle_nodes (project_id, level, position, hash, left_child_hash, right_child_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const node of tree.nodes) {
      insertNode.run(body.projectId, node.level, node.position, node.hash, node.leftChildHash, node.rightChildHash);
    }

    conn()
      .prepare(
        `UPDATE projects SET status = 'local_locked', merkle_root = ?, scr_id = ?,
         locked_at = ?, updated_at = ?, is_active = 0 WHERE id = ?`,
      )
      .run(tree.root, scrId, now, now, body.projectId);
  });
  tx();

  return NextResponse.json({
    ok: true,
    scrId,
    merkleRoot: tree.root,
    leafCount: tree.leafCount,
    depth: tree.depth,
    nodeCount: tree.nodes.length,
  });
}
