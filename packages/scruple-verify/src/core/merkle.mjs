// COPY of lib/witness/merkle.ts — see canonicalLeafV23.mjs header for the
// copy discipline. Only the inclusion-verification path is needed by the
// verifier — full tree construction stays on the server.

import { createHash } from 'node:crypto';

const LEAF_TAG = Buffer.from([0x01]);
const NODE_TAG = Buffer.from([0x00]);

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function hashLeaf(leafHashHex) {
  return sha256(Buffer.concat([LEAF_TAG, Buffer.from(leafHashHex, 'hex')]));
}

function hashNode(left, right) {
  return sha256(Buffer.concat([NODE_TAG, left, right]));
}

/** Recompute the Merkle root from a leaf hash + an inclusion path.
 *  path: [{sibling: '<64hex>', position: 'L' | 'R'}, ...] top-down. */
export function rootFromInclusion(leafHashHex, path) {
  let cur = hashLeaf(leafHashHex);
  for (const step of path) {
    const sib = Buffer.from(step.sibling, 'hex');
    cur = step.position === 'L' ? hashNode(sib, cur) : hashNode(cur, sib);
  }
  return cur.toString('hex');
}
