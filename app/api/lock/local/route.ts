// POST /api/lock/local
//
// Permanent local-disc finalize (≠ chain lock). Stripe pays $5.00;
// witness server verifies the payment server-side, signs the finalize
// lock event, and persists its own locked_projects row. We persist the
// returned countersignature locally so the receipt renders Scruple's
// second-party seal alongside the per-iteration witnesses.
//
// Body: { projectId: number, paymentIntentId: string }
//
// Dev is identical code against sandbox endpoints (sk_test_*); signin
// is gated by SCRUPLE_ALLOWED_EMAILS. There is no payment bypass.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { buildMerkle } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import { witness } from '@/lib/scruple/witness';
import { watermarkProjectIterations, lockLeafOrder, type ApplyResult } from '@/lib/watermark/apply';
import type { ProjectRow, IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Body = z.object({
  projectId: z.number().int().positive(),
  paymentIntentId: z.string().min(1).optional(),
  dev_bypass: z.boolean().optional(),
});

function devBypassAllowed(body: z.infer<typeof Body>): boolean {
  if (!body.dev_bypass) return false;
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.SCRUPLE_LOCK_DEV_BYPASS === '1';
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: 'paymentIntentId and projectId required', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  if (!body.paymentIntentId && !devBypassAllowed(body)) {
    return NextResponse.json(
      { error: 'paymentIntentId required (or set SCRUPLE_LOCK_DEV_BYPASS=1 in dev)' },
      { status: 400 },
    );
  }
  const paymentIntentId = body.paymentIntentId ?? `dev_bypass_${Date.now()}`;

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

  // ── ORDER MATTERS, AND IT USED TO BE WRONG ─────────────────────────────
  //
  // Until WO-28 this route built the Merkle over the master leaves,
  // finalized with the witness, and watermarked afterwards. `finalize`
  // inserts a locked_projects row, and the witness server 403s any
  // witness request for a project holding one — so the derivative was not
  // merely produced after the seal, it COULD NOT BE WITNESSED AT ALL.
  // `iterations.watermark_derivative_leaf_hash` (migration 038, July) had
  // been NULL since the day it landed for that reason.
  //
  // The order is now:
  //     watermark → witness each derivative → build the Merkle → finalize
  //
  // The 403 is untouched. It is the only thing stopping a sealed project
  // from growing a leaf afterwards, and a derivative is precisely the
  // leaf someone would want to add afterwards; the fix is to stop being
  // late, not to make the guard permissive.
  //
  // Failure here is still additive: an unreachable witness or a failed
  // embed costs the derivative its leaf, not the project its lock. The
  // difference from before is that the loss is now recorded — the leaf
  // columns stay NULL and `watermark.unwitnessed` says why.
  let watermarkResult: ApplyResult | null = null;
  try {
    watermarkResult = await watermarkProjectIterations({
      projectId: body.projectId,
      tier: 'local-lock',
      projectName: project.name,
    });
    console.log(`[LOCAL_LOCK] watermark applied=${watermarkResult.applied} witnessed=${watermarkResult.witnessed.length} unwitnessed=${watermarkResult.unwitnessed.length} skipped=${watermarkResult.skipped.length} errors=${watermarkResult.errors.length}`);
  } catch (e) {
    console.error('[LOCAL_LOCK] watermark step failed (lock proceeds over masters only):', e);
  }

  // The tree commits to BOTH artifacts: every master leaf in run_sequence
  // order, then every witnessed derivative leaf in its master's order.
  // Appending rather than interleaving is deliberate — a project with no
  // derivative yields the same root it would have yielded before WO-28,
  // and master leaf index still equals run_sequence − 1.
  //
  // Tier 3's payload carries no SCR-ID, so deriving the SCR-ID from the
  // FULL root is not circular. Tiers 4/5 embed the SCR-ID in the payload
  // and therefore cannot use this shape as-is: their payload depends on
  // the root which would depend on the payload. They need a two-phase
  // design (SCR-ID from the master-only root, derivative leaves extending
  // the tree afterwards, and the receipt stating that the SCR-ID commits
  // to the masters while the final root commits to both). Neither
  // chain-lock route calls the watermarker today; this is written down so
  // that whoever wires them does not discover it at runtime.
  const masterLeaves = iterations.map((i) => i.leaf_hash);
  const leaves = lockLeafOrder(masterLeaves, watermarkResult?.witnessed ?? []);
  const tree = buildMerkle(leaves);
  if (!tree.root) return NextResponse.json({ error: 'Merkle root computation failed' }, { status: 500 });

  const scrId = deriveScrId(tree.root, false);

  // Witness-server-gated Stripe verification + countersignature.
  let exec: { success: boolean; error?: string; serverSignature?: string; lockedAt?: string };
  if (devBypassAllowed(body)) {
    const now = new Date().toISOString();
    exec = {
      success: true,
      serverSignature: `DEV_BYPASS_${Date.now()}_${paymentIntentId}`,
      lockedAt: now,
    };
    console.log(`[LOCAL LOCK] DEV BYPASS user=${userId} project=${project.id}`);
  } else {
    try {
      exec = await witness.confirmAndExecute({
        action: 'finalize',
        projectId: String(project.id),
        paymentIntentId,
        merkleRoot: tree.root,
        preScrId: scrId,
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
        { error: 'Witness rejected finalize', detail: exec.error ?? 'unknown' },
        { status: 402 },
      );
    }
  }

  const now = new Date().toISOString();
  const lockSig = exec.serverSignature ?? null;
  const lockedAtWitnessed = exec.lockedAt ?? null;
  const tx = conn().transaction(() => {
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
         lock_server_signature = ?, lock_locked_at_witnessed = ?,
         locked_at = ?, updated_at = ?, is_active = 0 WHERE id = ?`,
      )
      .run(tree.root, scrId, lockSig, lockedAtWitnessed, now, now, body.projectId);
  });
  tx();

  console.log(`[LOCAL_LOCK] user=${userId} project=${body.projectId} scr=${scrId} leaves=${tree.leafCount} (masters=${masterLeaves.length} derivatives=${watermarkResult?.witnessed.length ?? 0}) root=${tree.root.slice(0, 16)}… sig=${(lockSig ?? '').slice(0, 12)}…`);

  return NextResponse.json({
    ok: true,
    scrId,
    merkleRoot: tree.root,
    leafCount: tree.leafCount,
    // The leaf count is no longer the iteration count. Say so explicitly
    // rather than leaving a verifier to infer it.
    masterLeafCount: masterLeaves.length,
    derivativeLeafCount: watermarkResult?.witnessed.length ?? 0,
    depth: tree.depth,
    nodeCount: tree.nodes.length,
    paymentVerified: true,
    serverSignature: lockSig,
    lockedAtWitnessed,
    watermark: watermarkResult,
  });
}
