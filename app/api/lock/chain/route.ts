// POST /api/lock/chain
//
// Chain-lock pipeline: payment → witness signature → on-chain anchoring.
// In v1 the on-chain pieces (RVN mint, IPFS pin, Arweave commit) are
// fulfilled by the existing witness server's lockProject endpoint. We
// witness all iterations, ask the witness server to lock, then mark
// the project chain_locked locally with the returned merkle root +
// server signature.
//
// Stripe is wired stub — when STRIPE_SECRET_KEY is unset we skip the
// payment step and proceed (gated behind LOCK_REQUIRE_PAYMENT env).
//
// Body: { projectId: number, paymentIntentId?: string }

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { conn } from '@/lib/db/sqlite';
import { witness } from '@/lib/scruple/witness';
import { buildLockPackage, recordPackageHash } from '@/lib/scruple/lock-package';
import type { ProjectRow, IterationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const REQUIRE_PAYMENT = process.env.LOCK_REQUIRE_PAYMENT === '1';

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
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.projectId, userId) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  if (project.status === 'chain_locked' || project.status === 'persistent_locked' ||
      project.status === 'permanent_locked') {
    return NextResponse.json({ error: `Already ${project.status}` }, { status: 409 });
  }

  if (REQUIRE_PAYMENT && !body.paymentIntentId) {
    return NextResponse.json({ error: 'paymentIntentId required' }, { status: 402 });
  }

  const iterations = conn()
    .prepare(`SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`)
    .all(body.projectId) as IterationRow[];
  if (iterations.length === 0) {
    return NextResponse.json({ error: 'No iterations to lock' }, { status: 400 });
  }

  // ── Witness any un-witnessed iterations ────────────────────────────────
  const witnessedRows: Array<{ id: number; witness_id: string; signature: string; ts: string }> = [];
  // The witness server's project_id is a string; we use the scruple-web
  // project id prefixed with the user's id to keep the namespace global.
  const witnessProjectId = `sw:${userId}:${project.id}`;

  for (const it of iterations) {
    if (it.witnessed === 1 && it.witness_id) continue;
    try {
      const r = await witness.witnessIteration({
        projectId: witnessProjectId,
        projectName: project.name,
        runSequence: it.run_sequence,
        contentHash: it.leaf_hash,
      });
      witnessedRows.push({
        id: it.id,
        witness_id: r.witness_id,
        signature: r.signature,
        ts: r.server_timestamp,
      });
    } catch (e) {
      return NextResponse.json(
        { error: `Witness failed at iteration ${it.run_sequence}: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
  }

  // ── Persist witness fields ─────────────────────────────────────────────
  const updateIter = conn().prepare(
    `UPDATE iterations SET witnessed = 1, witness_id = ?, witness_signature = ?, witness_timestamp = ? WHERE id = ?`,
  );
  const tx = conn().transaction(() => {
    for (const w of witnessedRows) {
      updateIter.run(w.witness_id, w.signature, w.ts, w.id);
    }
  });
  tx();

  // ── Ask witness server to lock and return server-side merkle root ──────
  let lockResult;
  try {
    lockResult = await witness.lockProject(witnessProjectId);
  } catch (e) {
    return NextResponse.json(
      { error: `Witness lock failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // Build local lock package (deterministic JSON manifest)
  const now = new Date().toISOString();
  const pkg = buildLockPackage(body.projectId);
  recordPackageHash(body.projectId, pkg.packageHash);

  // Update local project row to chain_locked. The witness server now mints
  // on RVN testnet — persist the proofTxId + scrId. mintError (when set)
  // surfaces as a soft-warning in the response; lock still records.
  conn()
    .prepare(
      `UPDATE projects SET
         status = 'chain_locked',
         merkle_root = ?,
         witness_signature = ?,
         witnessed_count = ?,
         scr_id = COALESCE(?, scr_id),
         rvn_txid = COALESCE(?, rvn_txid),
         locked_at = ?, updated_at = ?,
         is_active = 0
       WHERE id = ?`,
    )
    .run(
      lockResult.merkle_root,
      lockResult.server_signature,
      iterations.length,
      lockResult.scrId ?? null,
      lockResult.proofTxId ?? null,
      now,
      now,
      body.projectId,
    );

  return NextResponse.json({
    ok: true,
    merkleRoot: lockResult.merkle_root,
    witnessedCount: iterations.length,
    serverSignature: lockResult.server_signature,
    lockedAt: now,
    packageHash: pkg.packageHash,
    scrId: lockResult.scrId ?? null,
    proofTxId: lockResult.proofTxId ?? null,
    proofChain: lockResult.proofChain ?? null,
    mintError: lockResult.mintError ?? null,
  });
}
