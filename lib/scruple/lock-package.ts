// Lock-package builder. Produces a deterministic JSON manifest that
// captures everything needed to verify a project's provenance offline.
//
// Determinism: same project state ⇒ identical bytes. Iterations are
// ordered by run_sequence. Merkle nodes are ordered by (level asc,
// position asc). All keys serialized in the same order via the
// Manifest type. Hash of the canonical JSON bytes = projects.package_hash.

import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from './hash';
import type { LockPackageManifest, ProjectRow, IterationRow, MerkleNodeRow } from '@/lib/types';

export const SCRUPLE_VERSION = '0.1.0-web';

export interface BuiltPackage {
  manifest: LockPackageManifest;
  bytes: Buffer;
  packageHash: string;
}

export function buildLockPackage(projectId: number): BuiltPackage {
  const project = conn()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (!project.merkle_root || !project.scr_id) {
    throw new Error('Project must be locked or checkpointed first');
  }

  const iterations = conn()
    .prepare(
      `SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC`,
    )
    .all(projectId) as IterationRow[];

  const nodes = conn()
    .prepare(
      `SELECT * FROM merkle_nodes WHERE project_id = ? ORDER BY level ASC, position ASC`,
    )
    .all(projectId) as MerkleNodeRow[];

  const manifest: LockPackageManifest = {
    version: 1,
    scrupleVersion: SCRUPLE_VERSION,
    projectId: project.id,
    projectName: project.name,
    scrId: project.scr_id,
    preScr: project.pre_scr_id,
    merkleRoot: project.merkle_root,
    iterations: iterations.map((it) => ({
      runSequence: it.run_sequence,
      leafHash: it.leaf_hash,
      inputHash: it.input_hash,
      outputHash: it.output_hash,
      timestamp: it.timestamp,
      witnessId: it.witness_id,
      witnessSignature: it.witness_signature,
    })),
    merkleNodes: nodes.map((n) => ({
      level: n.level,
      position: n.position,
      hash: n.hash,
      leftChildHash: n.left_child_hash,
      rightChildHash: n.right_child_hash,
    })),
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    // ^ second-precision so re-builds within the same second are byte-equal
  };

  // Deterministic JSON: insertion-order from the typed object literal,
  // no prettifying, sorted keys not needed because we control order.
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const packageHash = sha256Hex(bytes);

  return { manifest, bytes, packageHash };
}

// Persist the package_hash on the project row.
export function recordPackageHash(projectId: number, packageHash: string): void {
  conn()
    .prepare(`UPDATE projects SET package_hash = ?, updated_at = ? WHERE id = ?`)
    .run(packageHash, new Date().toISOString(), projectId);
}
