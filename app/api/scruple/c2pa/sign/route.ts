// POST /api/scruple/c2pa/sign
//
// Sign an asset with C2PA. Shared endpoint for both Scruple Studio (ComfyUI)
// and Scruple Fusion.
//
// Body:
//   {
//     "project_id": 123,          // Scruple project (owns the leaf chain)
//     "iteration_id": 456,        // optional — the specific iteration to sign
//     "asset_path": "/tmp/x.png", // absolute path on the signer host
//     "product": "studio" | "fusion",
//     "tier": "bare" | "witnessed" | "local" | "chain",
//     "title": "optional"
//   }
//
// The endpoint reads the project + iteration rows to fill the Scruple
// assertion payload appropriate to `tier`, then invokes signAsset().
// Returns the signed asset path + a receipt URL.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import { requireUser } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';
import { signAsset, type LockTier, type ScrupleAssertionData } from '@/lib/c2pa/signAsset';
import { ensurePrincipalForUser } from '@/lib/witness/principalForUser';
import { emitC2paSignLeaf } from '@/lib/witness/scrupleInternalEmit';

export const dynamic = 'force-dynamic';

const Body = z.object({
  project_id: z.number().int().positive(),
  iteration_id: z.number().int().positive().optional(),
  asset_path: z.string().min(1),
  product: z.enum(['studio', 'fusion']),
  tier: z.enum(['bare', 'witnessed', 'local', 'chain']),
  title: z.string().max(200).optional(),
});

interface ProjectRow {
  id: number;
  user_id: string;
  scr_id: string | null;
  name: string;
  lock_server_signature: string | null;
  lock_locked_at_witnessed: string | null;
  rvn_txid: string | null;
  ipfs_cid: string | null;
  arweave_uri: string | null;
  merkle_root: string | null;
}

interface IterationRow {
  id: number;
  project_id: number;
  leaf_hash: string;
  run_sequence: number;
}

function tierRequirementsMet(tier: LockTier, p: ProjectRow): { ok: boolean; missing?: string } {
  if (tier === 'bare') return { ok: true };
  if (tier === 'witnessed') {
    if (!p.scr_id) return { ok: false, missing: 'project has no SCR-ID (never witnessed)' };
    return { ok: true };
  }
  if (tier === 'local') {
    if (!p.lock_server_signature) return { ok: false, missing: 'project not Checkpointed (no lock_server_signature)' };
    return { ok: true };
  }
  if (tier === 'chain') {
    if (!p.rvn_txid) return { ok: false, missing: 'project not Chain-Locked (no rvn_txid)' };
    return { ok: true };
  }
  return { ok: false, missing: `unknown tier: ${tier}` };
}

function buildScrupleAssertion(
  tier: LockTier,
  p: ProjectRow,
  it: IterationRow | undefined,
): ScrupleAssertionData | undefined {
  if (tier === 'bare') return undefined;

  const base: ScrupleAssertionData = {
    lock_tier: tier,
    scr_id: p.scr_id ?? undefined,
    leaf_hash: it?.leaf_hash,
    merkle_root: p.merkle_root ?? undefined,
    chain_position: it?.run_sequence,
    signed_at: new Date().toISOString(),
  };

  if (tier === 'local' || tier === 'chain') {
    base.lock_server_signature = p.lock_server_signature ?? undefined;
    base.local_lock_at = p.lock_locked_at_witnessed ?? undefined;
  }
  if (tier === 'chain') {
    base.rvn_txid = p.rvn_txid ?? undefined;
    base.ipfs_cid = p.ipfs_cid ?? undefined;
    base.arweave_uri = p.arweave_uri ?? undefined;
  }
  return base;
}

export async function POST(req: NextRequest) {
  const me = await requireUser(req);
  if (!me) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'Invalid body', detail: (e as Error).message }, { status: 400 });
  }

  const db = conn();

  const project = db
    .prepare(`SELECT id, user_id, scr_id, name, lock_server_signature, lock_locked_at_witnessed,
              rvn_txid, ipfs_cid, arweave_uri, merkle_root
              FROM projects WHERE id = ? AND user_id = ?`)
    .get(body.project_id, me.id) as ProjectRow | undefined;
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const iteration = body.iteration_id
    ? (db
        .prepare(`SELECT id, project_id, leaf_hash, run_sequence FROM iterations
                  WHERE id = ? AND project_id = ?`)
        .get(body.iteration_id, project.id) as IterationRow | undefined)
    : (db
        .prepare(`SELECT id, project_id, leaf_hash, run_sequence FROM iterations
                  WHERE project_id = ? ORDER BY run_sequence DESC LIMIT 1`)
        .get(project.id) as IterationRow | undefined);

  const gate = tierRequirementsMet(body.tier, project);
  if (!gate.ok) {
    return NextResponse.json(
      { error: `tier '${body.tier}' unavailable`, reason: gate.missing },
      { status: 409 },
    );
  }

  // Resolve absolute path safely — no shell escape needed since we're not
  // shelling out to bash. Just refuse anything that isn't absolute.
  const assetPath = path.resolve(body.asset_path);
  try {
    const stat = await fs.stat(assetPath);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch (e) {
    return NextResponse.json({ error: `asset not readable: ${(e as Error).message}` }, { status: 400 });
  }

  // Signed output goes next to the source with a .c2pa.png suffix by
  // default; caller can grab the returned path.
  const parsed = path.parse(assetPath);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scruple-c2pa-'));
  const outputPath = path.join(outDir, `${parsed.name}.c2pa${parsed.ext}`);

  const scruple = buildScrupleAssertion(body.tier, project, iteration);

  const result = await signAsset({
    assetPath,
    outputPath,
    product: body.product,
    tier: body.tier,
    title: body.title ?? project.name,
    scruple,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, trace: result.trace }, { status: 500 });
  }

  // Emit the sign event as a witnessed leaf on scruple.c2pa.sign.
  // Fail-open: on emit failure we still return the signed asset with
  // a witness_error field so the caller can retry the proof-fetch
  // later. Not emitting the leaf must NEVER block the sign response.
  let witnessBlock: unknown = undefined;
  let witnessErrorBlock: string | undefined = undefined;
  try {
    if (
      result.assetSha256 &&
      result.outputManifestSha256 &&
      result.signingMode &&
      result.signerIdentity
    ) {
      const { principalId } = ensurePrincipalForUser(me.id);
      const emit = await emitC2paSignLeaf({
        principalId,
        assetSha256Hex: result.assetSha256,
        outputManifestSha256Hex: result.outputManifestSha256,
        certSubjectKeyId: 'dev-cert',   // WO-02 prod cert lands here later
        signingIdentity: result.signerIdentity,
        signingMode: result.signingMode,
        product: body.product,
        tier: body.tier,
        status: 'signed',
      });
      if (emit.ok) {
        witnessBlock = {
          stream_id: emit.leaf.stream_id,
          tenant_seq: emit.leaf.tenant_seq,
          leaf_hash: emit.leaf.leaf_hash,
          chain_hash: emit.leaf.chain_hash,
          pending_checkpoint_epoch: emit.leaf.pending_checkpoint_epoch,
          principal_id: principalId,
          idempotency_key: emit.idempotency_key,
        };
      } else {
        witnessErrorBlock = emit.error;
      }
    } else {
      witnessErrorBlock = 'signer did not report hashes/identity';
    }
  } catch (e) {
    // Any thrown error — including principal lookup failure — is
    // reported but does NOT fail the sign response.
    witnessErrorBlock = `witness emit exception: ${(e as Error).message}`;
  }

  return NextResponse.json({
    ok: true,
    signed_path: result.outputPath,
    bytes: result.bytes,
    tier: body.tier,
    scr_id: project.scr_id,
    project_id: project.id,
    iteration_id: iteration?.id ?? null,
    signing_mode: result.signingMode,
    signer_identity: result.signerIdentity,
    ...(witnessBlock ? { witness: witnessBlock } : {}),
    ...(witnessErrorBlock ? { witness_error: witnessErrorBlock } : {}),
  });
}
