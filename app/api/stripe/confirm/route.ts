// POST /api/stripe/confirm
//
// After the user confirms a Stripe Payment Element on the client,
// this route:
//   1. Verifies project ownership.
//   2. Builds the Merkle root locally over the project's iterations
//      (so we have a deterministic root + SCR-ID to display in
//      receipts and persist regardless of witness mint outcome).
//   3. POSTs witness `/api/confirm-and-execute`. Witness server
//      re-retrieves the PaymentIntent from Stripe, verifies status,
//      action, amount, and metadata anti-tamper, then records the
//      payment + (for chain-lock) the RVN testnet asset state.
//   4. On witness success, updates the local scruple-web project row
//      so the UI reflects the new lock state immediately. This is
//      the step that was missing — payments were succeeding and the
//      witness was acknowledging, but the local UI continued to show
//      the project as 'unlocked'.
//
// NB: PaymentIntent metadata.projectId is `sw:userId:projectId` (see
// /api/stripe/payment-intent), so we MUST send the same namespaced
// projectId to witness's confirm-and-execute or the anti-tamper
// check rejects the request.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { witness } from '@/lib/scruple/witness';
import { buildMerkle } from '@/lib/scruple/merkle';
import { deriveScrId } from '@/lib/scruple/hash';
import { buildLockPackage, recordPackageHash } from '@/lib/scruple/lock-package';
import type { ProjectRow, IterationRow, LockState } from '@/lib/types';

const Body = z.object({
  paymentIntentId: z.string(),
  action: z.enum(['finalize', 'checkpoint', 'chain-lock-basic', 'chain-lock-pinned']),
  projectId: z.number().int().positive(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // State guards — match the inline lock routes' rules.
  if (body.action === 'checkpoint' &&
      project.status !== 'unlocked' && project.status !== 'checkpointed') {
    return NextResponse.json({ error: `Project is ${project.status}` }, { status: 409 });
  }
  if (body.action === 'finalize' &&
      (project.status === 'local_locked' || project.status === 'chain_locked' ||
       project.status === 'persistent_locked' || project.status === 'permanent_locked')) {
    return NextResponse.json({ error: `Project is already ${project.status}` }, { status: 409 });
  }
  if ((body.action === 'chain-lock-basic' || body.action === 'chain-lock-pinned') &&
      (project.status === 'chain_locked' || project.status === 'persistent_locked' ||
       project.status === 'permanent_locked')) {
    return NextResponse.json({ error: `Already ${project.status}` }, { status: 409 });
  }

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(body.projectId) as IterationRow[];
  if (iterations.length === 0) {
    return NextResponse.json({ error: 'No iterations to lock' }, { status: 400 });
  }

  const tree = buildMerkle(iterations.map((i) => i.leaf_hash));
  if (!tree.root) return NextResponse.json({ error: 'Merkle root computation failed' }, { status: 500 });
  const preScr = deriveScrId(tree.root, false);

  // Witness anti-tamper requires this exact projectId form — see
  // /api/stripe/payment-intent which sets it as PaymentIntent metadata.
  const witnessProjectId = `sw:${userId}:${body.projectId}`;

  let exec;
  try {
    exec = await witness.confirmAndExecute({
      action: body.action,
      projectId: witnessProjectId,
      paymentIntentId: body.paymentIntentId,
      installationId: userId,
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
      { error: 'Witness rejected lock', detail: exec.error ?? 'unknown' },
      { status: 402 },
    );
  }

  // Local persistence — witness has signed off, now reflect the new
  // state in the scruple-web DB so the UI updates.
  const now = new Date().toISOString();
  const isChain = body.action === 'chain-lock-basic' || body.action === 'chain-lock-pinned';
  const isPinned = body.action === 'chain-lock-pinned';
  const scrId = exec.scrId ?? preScr;
  const proofTxId = exec.proofTxId ?? null;
  const ipfsCid = exec.ipfsCid ?? null;
  const arweaveTxId = exec.arweaveTxId ?? null;

  const newStatus: LockState =
    body.action === 'checkpoint' ? 'checkpointed'
    : body.action === 'finalize' ? 'local_locked'
    : isPinned ? 'persistent_locked'
    : 'chain_locked';

  const tx = conn().transaction(() => {
    // Replace merkle nodes — every lock action snapshots the current tree.
    conn().prepare(`DELETE FROM merkle_nodes WHERE project_id = ?`).run(body.projectId);
    const insertNode = conn().prepare(
      `INSERT INTO merkle_nodes (project_id, level, position, hash, left_child_hash, right_child_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const n of tree.nodes) {
      insertNode.run(body.projectId, n.level, n.position, n.hash, n.leftChildHash, n.rightChildHash);
    }

    if (body.action === 'checkpoint') {
      conn()
        .prepare(
          `UPDATE projects SET status = ?, merkle_root = ?, pre_scr_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(newStatus, tree.root, preScr, now, body.projectId);
    } else if (body.action === 'finalize') {
      conn()
        .prepare(
          `UPDATE projects SET status = ?, merkle_root = ?, scr_id = ?,
             locked_at = ?, updated_at = ?, is_active = 0
           WHERE id = ?`,
        )
        .run(newStatus, tree.root, scrId, now, now, body.projectId);
    } else {
      // chain-lock-basic | chain-lock-pinned
      conn()
        .prepare(
          `UPDATE projects SET
             status = ?,
             merkle_root = ?,
             witnessed_count = ?,
             scr_id = ?,
             rvn_txid = COALESCE(?, rvn_txid),
             ipfs_cid = COALESCE(?, ipfs_cid),
             arweave_uri = COALESCE(?, arweave_uri),
             locked_at = ?, updated_at = ?,
             is_active = 0
           WHERE id = ?`,
        )
        .run(
          newStatus,
          tree.root,
          iterations.length,
          scrId,
          proofTxId,
          ipfsCid,
          arweaveTxId,
          now,
          now,
          body.projectId,
        );
    }
  });
  tx();

  // Deterministic lock-package manifest (separate from witness sig) —
  // only meaningful for chain locks where the project is sealed.
  let packageHash: string | null = null;
  if (isChain || body.action === 'finalize') {
    const pkg = buildLockPackage(body.projectId);
    recordPackageHash(body.projectId, pkg.packageHash);
    packageHash = pkg.packageHash;
  }

  return NextResponse.json({
    ok: true,
    action: body.action,
    status: newStatus,
    merkleRoot: tree.root,
    scrId,
    proofTxId,
    rvnTxId: proofTxId, // alias for LockResultModal which reads rvnTxId
    proofChain: exec.proofChain ?? null,
    mintError: exec.mintError ?? null,
    ipfsCid,
    ipfsError: exec.ipfsError ?? null,
    arweaveTxId,
    arweaveError: exec.arweaveError ?? null,
    witnessedCount: iterations.length,
    packageHash,
    lockedAt: now,
  });
}
