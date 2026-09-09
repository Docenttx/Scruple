// Generate the shared canonical-Merkle vectors.
//
// WO-C6. `test/vectors/merkle-vectors.json` is the artefact Appendix C item 0
// names: the SHARED VECTORS that witness and verifier must both pass before a
// leaf may stop saying `stale`. Until they pass, `CHECKPOINT_VECTORS_SETTLED`
// stays false and every leaf keeps saying `stale` — which is the state this
// generator's own output records, not a state it fixes.
//
// ---------------------------------------------------------------------------
// ⚑ THE LEAF SET IS DESCENDING, AND THAT IS THE WHOLE DESIGN OF THIS FILE
// ---------------------------------------------------------------------------
//
// Measured before this file existed (`01-divergence.txt`): with leaves in
// ASCENDING hex order, `lib/scruple/merkle.ts` (sorted-pair) and the witness
// server (plain concat) produce THE SAME ROOT at n = 1, 2, 4 — because sorting
// an already-sorted pair is a no-op. A vector file built from `sha256("leaf1"),
// sha256("leaf2"), ...` in whatever order they came out would therefore show
// two of the three implementations agreeing, and would have been read as
// evidence that only one implementation was wrong.
//
// So every leaf set here is DESCENDING, and one is shuffled. A vector set that
// cannot tell sorted-pair apart from concat is a green test with no control,
// which is the failure this WO series exists to refuse.
//
// The tree SIZES are chosen the same way: 1, 2, 3, 4, 5, 7, 8, 9, 100. The
// powers of two are where duplicate-last and RFC 6962's split agree, so a
// vector file made only of powers of two would show `lib/witness/merkle.ts`
// failing for one reason (swapped tags) and hide the second, worse one
// (CVE-2012-2459 ambiguity at odd sizes).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  merkleRoot,
  inclusionProof,
  inclusionPath,
  MERKLE_VERSION,
  MERKLE_ALGORITHM_ID,
} from './merkle-canonical-spec.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Leaf hashes that look like real ones (sha256 of a label) but in DESCENDING
 *  order, so a sorted-pair implementation cannot coincide with a concat one. */
function descendingLeaves(n) {
  const pool = [];
  for (let i = 0; pool.length < n; i++) pool.push(sha(`scruple-wo-c6-leaf-${i}`));
  return pool.sort().reverse().slice(0, n);
}

/** A deliberately shuffled set — neither ascending nor descending. */
function shuffledLeaves(n) {
  const l = descendingLeaves(n);
  // fixed permutation, no RNG: vectors must be byte-reproducible.
  const out = [];
  for (let i = 0; i < l.length; i++) out.push(l[(i * 7 + 3) % l.length]);
  return out;
}

const SETS = [
  { name: 'n=0 — the empty tree; MTH({}) = SHA-256() and nothing else', leaves: [] },
  { name: 'n=1 — one leaf is still SHA-256(0x00 || d0), NOT the leaf itself', leaves: descendingLeaves(1) },
  { name: 'n=2 — descending, so sorted-pair and plain concat diverge here', leaves: descendingLeaves(2) },
  { name: 'n=3 — the first odd split; RFC 6962 k=2, duplicate-last k=4', leaves: descendingLeaves(3) },
  { name: 'n=4 — a power of two; duplicate-last agrees on SHAPE, not on tags', leaves: descendingLeaves(4) },
  { name: 'n=5 — split 4|1, the deepest asymmetry at a small size', leaves: descendingLeaves(5) },
  { name: 'n=7 — split 4|3, both halves ragged', leaves: descendingLeaves(7) },
  { name: 'n=8 — a power of two, shuffled rather than ordered', leaves: shuffledLeaves(8) },
  { name: 'n=9 — split 8|1, one leaf alone against a full subtree', leaves: descendingLeaves(9) },
  { name: 'n=100 — a checkpoint-sized tree, shuffled', leaves: shuffledLeaves(100) },
];

const canonical = SETS.map((set) => {
  const root = merkleRoot(set.leaves);
  const n = set.leaves.length;
  // Proofs for every index up to 9 leaves; for n=100 take the ends and some
  // interior indices, including the ones that exercise the odd-walk branch.
  const indices =
    n === 0 ? [] : n <= 9 ? [...Array(n).keys()] : [0, 1, 63, 64, 98, 99];
  return {
    name: set.name,
    tree_size: n,
    leaves: set.leaves,
    root,
    proofs: indices.map((i) => inclusionProof(i, set.leaves, null)),
  };
});

// ---------------------------------------------------------------------------
// Ambiguity: what duplicate-last does and the canonical rule does not.
// ---------------------------------------------------------------------------
const ambiguitySets = [
  { name: 'CVE-2012-2459 — [a,b,c] vs [a,b,c,c]', a: descendingLeaves(3), b: [...descendingLeaves(3), descendingLeaves(3)[2]] },
  { name: 'the same at n=5 — [a..e] vs [a..e,e]', a: descendingLeaves(5), b: [...descendingLeaves(5), descendingLeaves(5)[4]] },
];
const ambiguity = ambiguitySets.map((s) => ({
  name: s.name,
  note:
    'Two DIFFERENT leaf sets. Under the canonical rule they have different roots. ' +
    'Under duplicate-last they have the SAME root, so one anchored root attests to two ' +
    'different histories and an inclusion proof for the phantom leaf verifies.',
  leaves_a: s.a,
  leaves_b: s.b,
  canonical_root_a: merkleRoot(s.a),
  canonical_root_b: merkleRoot(s.b),
}));

// ---------------------------------------------------------------------------
// Refused proofs — the half that proves the index is bound.
// ---------------------------------------------------------------------------
const base = descendingLeaves(7);
const baseRoot = merkleRoot(base);
const p3 = inclusionProof(3, base, null);

// ⚑ Each refusal records `origin` — the (leaf_index, tree_size) of the HONEST
// proof it was forged from. A verifier that trusts sides carried in the proof
// would be handed the origin's sides by the attacker, because those are the
// ones that reproduce the true root. Putting the attacker's own input in the
// vector file is what lets `scripts/merkle-conformance.mjs` show that format
// accepting the forgery, rather than asserting in prose that it would.
const origin37 = { leaf_index: 3, tree_size: 7 };
const origin67 = { leaf_index: 6, tree_size: 7 };

const refused_proofs = [
  {
    name: 'a valid path presented under a DIFFERENT leaf_index',
    why:
      'THE REASON THE CANONICAL CHOICE IS FORCED. The sides are derived from ' +
      '(leaf_index, tree_size), so moving the index re-derives a different walk and the ' +
      'root does not reproduce. A sorted-pair tree cannot refuse this at all — it has no ' +
      'index to contradict — and a proof that carries its own L/R sides refuses it only ' +
      'when the prover was honest about them.',
    true_root: baseRoot,
    origin: origin37,
    proof: { ...p3, leaf_index: 4 },
  },
  {
    name: 'the LAST leaf of a ragged tree presented under a DIFFERENT tree_size',
    why:
      'tree_size terminates the walk, and this is where it bites: index 6 of a 7-leaf tree ' +
      'has a 2-step path because its subtree is ragged, while index 6 of an 8-leaf tree needs 3. ' +
      'Presented as tree_size 8 the walk ends with sn != 0 and is refused. Without tree_size IN ' +
      'the proof there is nothing to fail on.',
    true_root: baseRoot,
    origin: origin67,
    proof: { ...inclusionProof(6, base, null), tree_size: 8 },
  },
  {
    name: 'a truncated path',
    why: 'sn must reach 0 exactly; a short path leaves it non-zero and is refused, not silently accepted.',
    true_root: baseRoot,
    origin: origin37,
    proof: { ...p3, path: p3.path.slice(0, -1) },
  },
  {
    name: 'a path with one extra sibling',
    why: 'the mirror of truncation — the walk must refuse a long path rather than ignore the tail.',
    true_root: baseRoot,
    origin: origin37,
    proof: { ...p3, path: [...p3.path, sha('extra')] },
  },
  {
    name: 'a sibling with one bit flipped',
    why: 'the ordinary case, included so the refusals are not all structural.',
    true_root: baseRoot,
    origin: origin37,
    proof: {
      ...p3,
      path: [
        (BigInt('0x' + p3.path[0]) ^ 1n).toString(16).padStart(64, '0'),
        ...p3.path.slice(1),
      ],
    },
  },
  {
    name: 'the leaf hash of a leaf that is not at that index',
    why: 'membership is not position; this is the claim sorted-pair cannot even express.',
    true_root: baseRoot,
    origin: origin37,
    proof: { ...p3, leaf_hash: base[5] },
  },
];

// ---------------------------------------------------------------------------
// ⚑ WHAT THE WALK ALONE DOES NOT REFUSE — found by the Python control, not by
// reading the RFC, and recorded so the cutover does not assume otherwise.
// ---------------------------------------------------------------------------
//
// A first draft of the refusal above used index 3 instead of index 6, and the
// Python recomputation reported it as a FAILED REFUSAL: the proof verified.
// It should have. Index 3 sits inside the full left 4-leaf subtree of both a
// 7-leaf and an 8-leaf tree, so every side in the walk is the same and the
// path reproduces a root either way. The walk is not lying — a tree_size the
// walk cannot contradict is one the walk cannot check.
//
// The consequence is a REQUIREMENT ON THE VERIFIER, not on the tree:
// `tree_size` and the recomputed root MUST BOTH be compared against the
// checkpoint record. Verifying the walk and stopping there accepts a proof
// carrying a tree_size that no checkpoint ever had.
const not_refusable_by_walk = [
  {
    name: 'index 3 of a 7-leaf tree presented as tree_size 8 — VERIFIES, and must',
    why:
      'Index 3 is inside the full left subtree, which is byte-identical in both trees, so the ' +
      'derived sides are identical and the walk reproduces the 7-leaf root. The walk is doing ' +
      'its job. THE VERIFIER MUST COMPARE tree_size AND root AGAINST THE CHECKPOINT RECORD; a ' +
      'verifier that only runs the walk accepts this.',
    true_root: baseRoot,
    proof: { ...p3, tree_size: 8 },
    verifies_under_the_walk: true,
  },
];

// ---------------------------------------------------------------------------
// A hand-checkable case, so the file is not only self-consistent.
// ---------------------------------------------------------------------------
const handLeaf = '00'.repeat(32);
const handCheck = {
  note:
    'Recomputable with shell tools alone — no Scruple code in the path. ' +
    'This is what stops the vectors from being merely self-consistent. ' +
    'The command is in `shell` below and scripts/merkle-conformance.mjs runs it.',
  single_leaf_hash_hex: handLeaf,
  preimage_hex: '00' + handLeaf,
  root: merkleRoot([handLeaf]),
  shell: "printf '%s' '00" + handLeaf + "' | xxd -r -p | sha256sum",
};

const doc = {
  note:
    'GENERATED by scripts/gen-merkle-vectors.mjs. WO-C6. THE SHARED VECTORS of ' +
    'Appendix C item 0. Four implementations must pass this file before ' +
    'CHECKPOINT_VECTORS_SETTLED may flip and a leaf may stop saying `stale`. ' +
    'Run scripts/merkle-conformance.mjs for the current pass/fail matrix, and ' +
    'scripts/merkle_canonical.py for the independent Python recomputation.',
  generated_from: 'scripts/merkle-canonical-spec.mjs',
  recomputed_by: 'scripts/merkle_canonical.py (must NOT read the roots from this file)',
  algorithm: {
    id: MERKLE_ALGORITHM_ID,
    merkle_version: MERKLE_VERSION,
    reference: 'RFC 6962 §2.1 (MTH), §2.1.1 (PATH), §2.1.2 (verification walk)',
    leaf_preimage: '0x00 || <32 raw bytes of leaf_hash>',
    node_preimage: '0x01 || <32 bytes left> || <32 bytes right>',
    empty_tree_root: 'SHA-256() = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    odd_levels: 'split at k = largest power of two STRICTLY LESS than n; NEVER duplicate the last leaf',
    leaf_order: 'ascending tenant_seq across [first_seq, last_seq]; gaps and duplicates are refused before the tree is built',
    proof_format:
      '{merkle_version, checkpoint_id, tree_size, leaf_index, leaf_hash, path[]} — path is bottom-up ' +
      '(leaf-adjacent sibling first) and carries NO L/R sides; the sides are derived from ' +
      '(leaf_index, tree_size), which is what binds the index',
    version_stamp_purpose:
      'FORWARD INSURANCE ONLY. There is no version 0 and there never was one — every artefact ' +
      'anchored before 2026-09-09 is test work and is being discarded, not migrated. The stamp ' +
      'exists so a change made AFTER real packages exist is survivable. It is not evidence that a ' +
      'legacy path existed.',
  },
  canonical,
  ambiguity,
  refused_proofs,
  not_refusable_by_walk,
  hand_check: handCheck,
};

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'vectors', 'merkle-vectors.json');
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`  ${canonical.length} trees, ${canonical.reduce((a, c) => a + c.proofs.length, 0)} proofs, ` +
  `${refused_proofs.length} refusals, ${not_refusable_by_walk.length} not-refusable-by-walk, ` +
  `${ambiguity.length} ambiguity pairs`);
