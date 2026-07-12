// Balanced binary Merkle tree for stream checkpoints.
//
// Rules (spec — cross-language parity required if Python side is later added):
//   - Leaf hash: sha256(0x01 || leaf_hash_bytes). RFC 6962-style domain
//     separation so a leaf's hash can never collide with an interior node's.
//   - Interior node: sha256(0x00 || left_bytes || right_bytes).
//   - Odd leaves at any level: the last leaf is duplicated (its hash pairs
//     with itself) to reach the next power of two. Documented convention;
//     matches c2patool's Merkle discipline.
//   - Input leaf hashes are lowercase 64-hex; internal storage is bytes;
//     output root is lowercase 64-hex.
//
// Inclusion proof shape:
//   Array of { sibling: <64-hex>, position: 'L' | 'R' }, top-down (root ⇒ leaf).
//   To verify: start with the leaf's domain-separated hash, then for each
//   step combine with sibling on the named side, hashing 0x00 || L || R.

import { createHash } from 'node:crypto';

const LEAF_TAG = Buffer.from([0x01]);
const NODE_TAG = Buffer.from([0x00]);

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}

function hashLeaf(leafHashHex: string): Buffer {
  return sha256(Buffer.concat([LEAF_TAG, Buffer.from(leafHashHex, 'hex')]));
}

function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([NODE_TAG, left, right]));
}

export interface InclusionStep {
  sibling: string;
  position: 'L' | 'R';
}

export interface MerkleTree {
  root: string;
  leafCount: number;
  /** Return the inclusion path from leaf at `index` up to the root. */
  inclusionPath(index: number): InclusionStep[];
}

export function buildBalancedMerkle(leafHashesHex: string[]): MerkleTree {
  if (leafHashesHex.length === 0) {
    throw new Error('empty leaf set');
  }
  const leafCount = leafHashesHex.length;
  // Level 0: domain-separated leaf hashes.
  let level: Buffer[] = leafHashesHex.map(hashLeaf);
  // Store all levels for cheap inclusion-proof extraction.
  const levels: Buffer[][] = [level];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last
      next.push(hashNode(l, r));
    }
    levels.push(next);
    level = next;
  }
  const root = level[0].toString('hex');

  return {
    root,
    leafCount,
    inclusionPath(index: number): InclusionStep[] {
      if (index < 0 || index >= leafCount) {
        throw new Error(`leaf index ${index} out of range [0, ${leafCount})`);
      }
      const path: InclusionStep[] = [];
      let idx = index;
      for (let d = 0; d < levels.length - 1; d++) {
        const layer = levels[d];
        const isRight = idx % 2 === 1;
        const siblingIdx = isRight ? idx - 1 : idx + 1;
        // If sibling is off-the-end (odd last leaf), self-duplicate.
        const sibling = siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];
        path.push({
          sibling: sibling.toString('hex'),
          position: isRight ? 'L' : 'R',
        });
        idx = Math.floor(idx / 2);
      }
      return path;
    },
  };
}

/** Recompute the root from a leaf hash + inclusion path. Symmetric with the
 *  builder above; used by the verifier CLI and consistency checks. */
export function rootFromInclusion(leafHashHex: string, path: InclusionStep[]): string {
  let cur = hashLeaf(leafHashHex);
  for (const step of path) {
    const sib = Buffer.from(step.sibling, 'hex');
    cur = step.position === 'L' ? hashNode(sib, cur) : hashNode(cur, sib);
  }
  return cur.toString('hex');
}
