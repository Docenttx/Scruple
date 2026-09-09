// The canonical Scruple Merkle construction — RFC 6962 §2.1, verbatim.
//
// WO-C6. ⚑ THIS FILE IS THE SPECIFICATION, NOT A LIBRARY. It lives under
// `scripts/` and not under `lib/` ON PURPOSE: WO-C6 is plan-and-vectors only
// and changes no root that anything computes today. A module under `lib/`
// would be one `import` away from becoming a fourth live construction before
// the cutover decides which of the existing three dies. The cutover work order
// (WO-C7, specified in `docs/canon/council-impl/WO-C6.md` §6) MOVES this
// construction into `lib/witness/merkle.ts` and deletes the losers; at that
// point this file is deleted too, and the vectors it generated stay.
//
// ---------------------------------------------------------------------------
// WHY RFC 6962 AND NOT ONE OF THE THREE WE HAVE
// ---------------------------------------------------------------------------
//
// The design requires an inclusion proof over the tuple
// (`checkpoint_id`, `index`, `leaf_hash`). A sorted-pair tree cannot carry the
// index: pair order comes from hash VALUE, not position, so a proof shows
// membership and is silent about where. That forecloses `lib/scruple/merkle.ts`
// on a requirement rather than a preference. Of what is left, RFC 6962 is the
// only published construction with domain separation, a defined proof format,
// and third-party verifiers that already exist.
//
// ---------------------------------------------------------------------------
// FOUR PLACES THIS DIFFERS FROM `lib/witness/merkle.ts`, WHICH CALLS ITSELF
// "RFC 6962-style". Each one is a root-changing difference.
// ---------------------------------------------------------------------------
//
//   1. TAG VALUES ARE SWAPPED. RFC 6962 §2.1 is 0x00 for a LEAF and 0x01 for
//      an INTERIOR NODE. `lib/witness/merkle.ts` uses 0x01 leaf / 0x00 node.
//      Domain separation still holds, but no off-the-shelf CT verifier agrees
//      with it, and a reader who checks it against the RFC finds a mismatch
//      with no note saying it was deliberate.
//   2. ODD LEVELS. RFC 6962 splits at the largest power of two STRICTLY LESS
//      than n. `lib/witness/merkle.ts` duplicates the last leaf, which is
//      CVE-2012-2459: MTH([a,b,c]) == MTH([a,b,c,c]), two different leaf sets
//      with one root. Measured, not asserted — see
//      `test/vectors/merkle-vectors.json` -> `ambiguity`.
//   3. THE LEAF PREIMAGE IS RAW BYTES. `d(i)` is the 32 decoded bytes of
//      `leaf_hash`, never its 64-character ASCII hex.
//   4. THE PROOF DOES NOT CARRY SIDES. See `inclusionProof` below.
//
// ---------------------------------------------------------------------------
// THE PROOF FORMAT, AND THE ONE DECISION IN IT THAT IS NOT RFC 6962 BOILERPLATE
// ---------------------------------------------------------------------------
//
// An inclusion proof is:
//
//   { merkle_version, checkpoint_id, tree_size, leaf_index, leaf_hash,
//     path: ["<64hex>", ...] }        // bottom-up: leaf-adjacent sibling first
//
// ⚑ THERE IS NO `position: 'L' | 'R'` FIELD, and its absence is the point.
// `lib/witness/merkle.ts` emits `{sibling, position}` pairs. If the prover
// chooses the sides, the verifier is checking a path the prover shaped, and
// `leaf_index` is decoration — the same sibling set can be walked to the same
// root under more than one index claim. Here the sides are DERIVED from
// (`leaf_index`, `tree_size`) by the RFC 6962 §2.1.2 walk, so a proof that
// verifies proves the leaf sits at that index in a tree of that size. That is
// the requirement `checkpoint_id, index, leaf_hash` was asking for, and the
// reason sorted-pair could never meet it.
//
// A second, smaller consequence: `tree_size` must be in the proof and must be
// checked against the checkpoint record, or the walk has no terminating
// condition to fail on.
//
// ⚑ `lib/witness/merkle.ts` and `packages/scruple-verify/src/core/merkle.mjs`
// BOTH document their path as "top-down (root ⇒ leaf)". Read the code: index 0
// is the leaf's own sibling, and `rootFromInclusion` consumes it starting at
// the leaf. Both are bottom-up and both comments are wrong. Anyone
// implementing from the comment rather than the code produces reversed proofs.
// Recorded because it is exactly the class of defect this WO exists to end.

import { createHash } from 'node:crypto';

const LEAF_TAG = Buffer.from([0x00]); // RFC 6962 §2.1 — leaf
const NODE_TAG = Buffer.from([0x01]); // RFC 6962 §2.1 — interior node

export const MERKLE_VERSION = 1;

/** The version stamp is FORWARD INSURANCE, not compatibility.
 *  See `docs/canon/council-impl/WO-C6.md` §7. Nothing that was ever anchored
 *  is being kept, so there is no version 0 and there never was one. */
export const MERKLE_ALGORITHM_ID = 'scruple-merkle-rfc6962-sha256-v1';

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** d(i) is the 32 decoded bytes of leaf_hash. Refuse anything else, loudly:
 *  a 64-char hex string silently coerced to ASCII is precisely how
 *  `lib/scruple/merkle.ts` and the witness server ended up hashing text. */
export function leafBytes(leafHashHex) {
  if (typeof leafHashHex !== 'string' || !/^[0-9a-f]{64}$/.test(leafHashHex)) {
    throw new Error(`leaf_hash must be 64 lowercase hex chars, got: ${String(leafHashHex).slice(0, 80)}`);
  }
  return Buffer.from(leafHashHex, 'hex');
}

export function hashLeaf(leafHashHex) {
  return sha256(Buffer.concat([LEAF_TAG, leafBytes(leafHashHex)]));
}

export function hashNode(left, right) {
  return sha256(Buffer.concat([NODE_TAG, left, right]));
}

/** Largest power of two strictly less than n. RFC 6962's k. */
export function splitPoint(n) {
  if (n < 2) throw new Error(`splitPoint requires n >= 2, got ${n}`);
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[n]) — RFC 6962 §2.1. Returns a 32-byte Buffer. */
export function mth(leafHashesHex) {
  const n = leafHashesHex.length;
  if (n === 0) return sha256(Buffer.alloc(0)); // MTH({}) = SHA-256()
  if (n === 1) return hashLeaf(leafHashesHex[0]);
  const k = splitPoint(n);
  return hashNode(mth(leafHashesHex.slice(0, k)), mth(leafHashesHex.slice(k)));
}

/** The canonical root as lowercase 64-hex. */
export function merkleRoot(leafHashesHex) {
  return mth(leafHashesHex).toString('hex');
}

/** PATH(m, D[n]) — RFC 6962 §2.1.1. Bottom-up: leaf-adjacent sibling first.
 *  Returns an array of 64-hex strings and NO sides. */
export function inclusionPath(index, leafHashesHex) {
  const n = leafHashesHex.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new Error(`leaf index ${index} out of range [0, ${n})`);
  }
  if (n === 1) return [];
  const k = splitPoint(n);
  if (index < k) {
    return [...inclusionPath(index, leafHashesHex.slice(0, k)), mth(leafHashesHex.slice(k)).toString('hex')];
  }
  return [...inclusionPath(index - k, leafHashesHex.slice(k)), mth(leafHashesHex.slice(0, k)).toString('hex')];
}

/** A complete, self-describing inclusion proof. */
export function inclusionProof(index, leafHashesHex, checkpointId) {
  return {
    merkle_version: MERKLE_VERSION,
    checkpoint_id: checkpointId ?? null,
    tree_size: leafHashesHex.length,
    leaf_index: index,
    leaf_hash: leafHashesHex[index],
    path: inclusionPath(index, leafHashesHex),
  };
}

/** RFC 6962 §2.1.2 verification walk. The sides come from (leaf_index,
 *  tree_size); nothing in the proof chooses them. Returns the recomputed root
 *  as 64-hex, or throws if the proof is malformed for that (index, size). */
export function rootFromProof(proof) {
  const { tree_size: n, leaf_index: m, leaf_hash: leafHashHex, path } = proof;
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad tree_size: ${n}`);
  if (!Number.isInteger(m) || m < 0 || m >= n) throw new Error(`leaf_index ${m} out of range [0, ${n})`);
  if (!Array.isArray(path)) throw new Error('path must be an array');

  let fn = m;
  let sn = n - 1;
  let r = hashLeaf(leafHashHex);
  for (const stepHex of path) {
    if (sn === 0) throw new Error('inclusion path too long for this tree_size');
    const p = leafBytes(stepHex);
    if (fn % 2 === 1 || fn === sn) {
      r = hashNode(p, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      r = hashNode(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (sn !== 0) throw new Error('inclusion path too short for this tree_size');
  return r.toString('hex');
}
