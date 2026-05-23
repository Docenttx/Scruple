// POST /api/lock/checkpoint
//
// Soft-lock that preserves progress without sealing. Stripe pays $5.00
// (test-mode in dev, live in prod); witness server verifies the payment
// server-side, signs the lock event, and returns its countersignature.
//
// Flow:
//   1. Verify project ownership + state (unlocked or checkpointed)
//   2. Build local Merkle over witnessed iterations
//   3. POST witness /api/confirm-and-execute with action='checkpoint',
//      paymentIntentId, projectId, merkleRoot, preScrId. Witness
//      re-retrieves the PaymentIntent from Stripe, verifies status +
//      amount + metadata, signs the lock data, returns serverSignature.
//   4. Persist merkle_nodes + project status='checkpointed' locally,
//      plus the witness countersignature (lock_server_signature) so
//      the receipt renders Scruple's second-party seal on this lock.
//
// Body: { projectId: number, paymentIntentId: string }
//
// There is no "dev bypass" — dev is the same code against sandbox
// endpoints (sk_test_*). Identity is gated at signin
// (SCRUPLE_ALLOWED_EMAILS) and CLI uses scripts/stripe-test-pay to
// drive the same Stripe Elements flow a browser would.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { buildMerkle } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import { witness } from '@/lib/scruple/witness';
import type { ProjectRow, IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Body = z.object({
  projectId: z.number().int().positive(),
  paymentIntentId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'paymentIntentId and projectId required', detail: String(e) },
      { status: 400 },
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

  // Witness-server-gated Stripe verification + countersignature.
  let exec;
  try {
    exec = await witness.confirmAndExecute({
      action: 'checkpoint',
      projectId: String(project.id),
      paymentIntentId: body.paymentIntentId,
      merkleRoot: tree.root,
      preScrId: preScr,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: 'Witness server unreachable for confirm-and-execute',
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
  if (!exec.success) {
    return NextResponse.json(
      { error: 'Witness rejected checkpoint', detail: exec.error ?? 'unknown' },
      { status: 402 },
    );
  }

  // Local persistence — only after witness server has signed off.
  const now = new Date().toISOString();
  const lockSig = exec.serverSignature ?? null;
  const lockedAtWitnessed = exec.lockedAt ?? null;
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
         lock_server_signature = ?, lock_locked_at_witnessed = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(tree.root, preScr, lockSig, lockedAtWitnessed, now, body.projectId);
  });
  tx();

  console.log(`[CHECKPOINT] user=${userId} project=${body.projectId} preScr=${preScr} leaves=${tree.leafCount} root=${tree.root.slice(0, 16)}… sig=${(lockSig ?? '').slice(0, 12)}…`);

  return NextResponse.json({
    ok: true,
    preScrId: preScr,
    merkleRoot: tree.root,
    leafCount: tree.leafCount,
    paymentVerified: true,
    serverSignature: lockSig,
    lockedAtWitnessed,
  });
}
