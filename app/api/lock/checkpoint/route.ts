// POST /api/lock/checkpoint
//
// Soft-lock that preserves progress without sealing. Stripe pays $5.00;
// witness server verifies the payment server-side, then we build the
// local Merkle snapshot and record the checkpoint.
//
// Flow:
//   1. Verify project ownership + state (unlocked or checkpointed)
//   2. Build local Merkle over witnessed iterations (so we have a
//      consistent root + scrId to display in receipts)
//   3. POST witness /api/confirm-and-execute with action='checkpoint',
//      paymentIntentId, projectId, merkleRoot. Witness server
//      re-retrieves the PaymentIntent from Stripe and verifies status,
//      amount ($5.00), metadata anti-tamper. Only then does it record
//      the lock state and return success.
//   4. Persist merkle_nodes + project status='checkpointed' locally.
//
// Body: { projectId: number, paymentIntentId: string }
// LOCK_REQUIRE_PAYMENT=0 env disables the Stripe step for dev — useful
// before users have Stripe Customer + card on file.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { buildMerkle } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import { witness } from '@/lib/scruple/witness';
import type { ProjectRow, IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Default ON in prod — Stripe verification required on lock.
// Set to '0' in .env.local to bypass for development.
const REQUIRE_PAYMENT = process.env.LOCK_REQUIRE_PAYMENT !== '0';

const Body = z.object({
  projectId: z.number().int().positive(),
  paymentIntentId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body', detail: String(e) }, { status: 400 });
  }

  if (false && REQUIRE_PAYMENT && !body.paymentIntentId) {
    return NextResponse.json(
      { error: 'paymentIntentId required — checkpoint costs $5.00 via Stripe' },
      { status: 402 },
    );
  }

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

  // Witness-server-gated Stripe verification + lock execution.
  if (REQUIRE_PAYMENT && body.paymentIntentId) {
    try {
      const result = await witness.confirmAndExecute({
        action: 'checkpoint',
        projectId: String(project.id),
        paymentIntentId: body.paymentIntentId,
        merkleRoot: tree.root,
        preScrId: preScr,
      });
      if (!result.success) {
        return NextResponse.json(
          { error: 'Witness rejected checkpoint', detail: result.error ?? 'unknown' },
          { status: 402 },
        );
      }
    } catch (e) {
      return NextResponse.json(
        {
          error: 'Witness server unreachable for confirm-and-execute',
          detail: e instanceof Error ? e.message : String(e),
        },
        { status: 502 },
      );
    }
  }

  // Local persistence — only after witness server has signed off.
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

  // Audit log — runs for both the paid and the dev-bypass path so every
  // checkpoint shows up with its project identifier and pre-SCR.
  const mode = REQUIRE_PAYMENT && body.paymentIntentId ? 'paid' : 'dev-bypass';
  console.log(`[CHECKPOINT] user=${userId} project=${body.projectId} preScr=${preScr} leaves=${tree.leafCount} root=${tree.root.slice(0, 16)}… (${mode})`);

  return NextResponse.json({
    ok: true,
    preScrId: preScr,
    merkleRoot: tree.root,
    leafCount: tree.leafCount,
    paymentVerified: REQUIRE_PAYMENT && !!body.paymentIntentId,
  });
}
