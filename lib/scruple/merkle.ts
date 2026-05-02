// Merkle tree library — server-side only. Algorithm is byte-compatible
// with research/electron-source/lock/merkle.js.
//
//   Build:
//     1. If 0 leaves → root = null.
//     2. If 1 leaf  → root = that leaf.
//     3. Otherwise build level by level:
//        - If odd count, duplicate last element.
//        - For each pair (a,b), pair-sort lexicographically, hash concat.
//        - Repeat until length 1.
//   Pair hash:
//     combined = a < b ? a + b : b + a
//     SHA-256(combined) → hex (lowercase)
//   All intermediate nodes are returned alongside the root.

import { sha256Hex } from './hash';

export interface MerkleNode {
  level: number;       // 0 = leaves, root has the largest level
  position: number;    // 0-indexed within its level
  hash: string;
  leftChildHash: string | null;
  rightChildHash: string | null;
}

export interface MerkleTree {
  root: string | null;
  nodes: MerkleNode[];
  leafCount: number;
  depth: number;       // number of edges from root to leaf
}

export function hashPair(left: string, right: string): string {
  const combined = left < right ? left + right : right + left;
  return sha256Hex(combined);
}

export function buildMerkle(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    return { root: null, nodes: [], leafCount: 0, depth: 0 };
  }

  const nodes: MerkleNode[] = [];

  // Single leaf — itself is the root.
  if (leaves.length === 1) {
    nodes.push({ level: 0, position: 0, hash: leaves[0], leftChildHash: null, rightChildHash: null });
    return { root: leaves[0], nodes, leafCount: 1, depth: 0 };
  }

  // Store leaf level (level 0).
  let level = 0;
  let current = [...leaves];
  current.forEach((hash, position) =>
    nodes.push({ level, position, hash, leftChildHash: null, rightChildHash: null }),
  );

  while (current.length > 1) {
    level++;
    // Pad odd-length levels by duplicating last element. This matches
    // desktop semantics; the duplicate is NOT stored as a separate leaf
    // (it's the same hash repeated).
    if (current.length % 2 === 1) {
      current.push(current[current.length - 1]);
    }

    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      const combined = hashPair(left, right);
      next.push(combined);
      nodes.push({
        level,
        position: next.length - 1,
        hash: combined,
        leftChildHash: left,
        rightChildHash: right,
      });
    }
    current = next;
  }

  return { root: current[0], nodes, leafCount: leaves.length, depth: level };
}

// Verify-only helper (no node storage). Useful for /api/verify.
export function computeRootFromLeaves(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];
  let current = [...leaves];
  while (current.length > 1) {
    if (current.length % 2 === 1) current.push(current[current.length - 1]);
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashPair(current[i], current[i + 1]));
    }
    current = next;
  }
  return current[0];
}
