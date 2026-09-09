// The conformance runner for the shared Merkle vectors.
//
// WO-C6. Appendix C item 0 makes "witness and verifier pass SHARED VECTORS"
// the condition on every leaf's `stale`. This executes
// `test/vectors/merkle-vectors.json` against EVERY root calculation in the
// estate and prints the matrix. It changes nothing.
//
// Run:  node scripts/merkle-conformance.mjs [--json] [--hand-check]
//
// ---------------------------------------------------------------------------
// 🔴 /opt/scruple-witness IS READ, NEVER WRITTEN, AND NOT EVEN THAT IF IT CAN
//    BE AVOIDED
// ---------------------------------------------------------------------------
// The deployed witness algorithm is executed from the IN-REPO copy at
// `services/witness-server/server.js`, after asserting it is byte-identical to
// `/opt/scruple-witness/server.js`. If the two ever differ the runner says so
// and marks that row UNKNOWN rather than reporting the repo copy as though it
// were the deployed one. `calculateMerkleRoot` is extracted by source text and
// evaluated in isolation, so no server starts, no database opens, and nothing
// listens on a port.
//
// ---------------------------------------------------------------------------
// THE CONTROLS, WHICH ARE THE REASON THIS FILE IS LONGER THAN THE MATRIX
// ---------------------------------------------------------------------------
// A runner that reports "everything fails" proves nothing — it is indis-
// tinguishable from a broken runner. So the same matrix carries rows that MUST
// pass and rows that MUST fail, and the runner EXITS NON-ZERO if any control
// lands the wrong way round, whatever the four real implementations do:
//
//   MUST PASS   the canonical spec itself; the independent Python
//               implementation; the shell hand-check.
//   MUST FAIL   five mutants of the canonical spec, each wrong in exactly one
//               named way — and mutant `dup-last` must fail ONLY at non-power-
//               of-two sizes, which is a precision check on the runner rather
//               than a blanket one. A runner that fails everything would fail
//               that mutant at n=4 too, and the run would go red.
//
// The four real implementations' results are REPORTED, not asserted, here.
// `test/v2/merkle-conformance.test.ts` is where the current matrix is pinned.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const VECTORS = path.join(REPO, 'test', 'vectors', 'merkle-vectors.json');
const REPO_WITNESS = path.join(REPO, 'services', 'witness-server', 'server.js');
const DEPLOYED_WITNESS = '/opt/scruple-witness/server.js';

const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

/* ══ the estate ══════════════════════════════════════════════════════════ */

/** Extract `calculateMerkleRoot` from the witness server WITHOUT running it. */
function loadWitnessServerRoot() {
  const repoSrc = fs.readFileSync(REPO_WITNESS, 'utf8');
  let identical = null;
  try {
    const deployedSrc = fs.readFileSync(DEPLOYED_WITNESS, 'utf8');
    identical = deployedSrc === repoSrc;
  } catch (e) {
    identical = null; // not present on this host — say so, do not guess
  }
  const m = repoSrc.match(/function calculateMerkleRoot\(hashes\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('calculateMerkleRoot not found in ' + REPO_WITNESS);
  const fn = new Function('crypto', `${m[0]}; return calculateMerkleRoot;`)(crypto);
  return { fn, identical, source: m[0] };
}

const witnessServer = loadWitnessServerRoot();

const scrupleMerkle = await import(path.join(REPO, 'lib', 'scruple', 'merkle.ts'));
const witnessMerkle = await import(path.join(REPO, 'lib', 'witness', 'merkle.ts'));
const verifyMerkle = await import(path.join(REPO, 'packages', 'scruple-verify', 'src', 'core', 'merkle.mjs'));
const canon = await import(path.join(HERE, 'merkle-canonical-spec.mjs'));

/* ══ mutants — each wrong in exactly one named way ════════════════════════ */

function mutantFactory({ leafTag, nodeTag, dupLast, hexPreimage }) {
  const L = Buffer.from([leafTag]);
  const N = Buffer.from([nodeTag]);
  const sha = (b) => createHash('sha256').update(b).digest();
  const hl = (hex) =>
    leafTag === null
      ? Buffer.from(hex, 'hex')
      : sha(Buffer.concat([L, hexPreimage ? Buffer.from(hex, 'utf8') : Buffer.from(hex, 'hex')]));
  const hn = (a, b) => (nodeTag === null ? sha(Buffer.concat([a, b])) : sha(Buffer.concat([N, a, b])));
  function mth(leaves) {
    const n = leaves.length;
    if (n === 0) return sha(Buffer.alloc(0));
    if (n === 1) return hl(leaves[0]);
    if (dupLast) {
      let level = leaves.map(hl);
      while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(hn(level[i], i + 1 < level.length ? level[i + 1] : level[i]));
        level = next;
      }
      return level[0];
    }
    const k = canon.splitPoint(n);
    return hn(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
  }
  return (leaves) => mth(leaves).toString('hex');
}

const MUTANTS = [
  { key: 'tags-swapped', why: '0x01 leaf / 0x00 node — the tag order lib/witness/merkle.ts actually uses', root: mutantFactory({ leafTag: 0x01, nodeTag: 0x00 }) },
  { key: 'no-domain-sep', why: 'no tags at all — the second-preimage weakness RFC 6962 exists to close', root: mutantFactory({ leafTag: null, nodeTag: null }) },
  { key: 'dup-last', why: 'duplicate-last instead of the RFC split — MUST fail ONLY at non-powers of two', root: mutantFactory({ leafTag: 0x00, nodeTag: 0x01, dupLast: true }) },
  { key: 'hex-preimage', why: 'hashes the 64-char ASCII hex instead of the 32 raw bytes', root: mutantFactory({ leafTag: 0x00, nodeTag: 0x01, hexPreimage: true }) },
];

/** The fifth mutant is a VERIFIER, not a tree: it consumes the
 *  `{sibling, position}` proof shape that `lib/witness/merkle.ts` emits, with
 *  canonical tags, so ONLY the format differs. The sides come from the proof
 *  rather than from (leaf_index, tree_size).
 *
 *  For an honest proof it derives them itself and agrees with the canonical
 *  verifier on every root. For a forgery the ATTACKER supplies them, and the
 *  attacker's choice is recorded in the vector file as `origin` — the honest
 *  (leaf_index, tree_size) the forgery was built from. That is the whole
 *  argument for dropping `position`: run it and see which refusals survive. */
function credulousVerifier(proof, sides) {
  let cur = canon.hashLeaf(proof.leaf_hash);
  proof.path.forEach((sib, i) => {
    const b = Buffer.from(sib, 'hex');
    cur = sides[i] === 'L' ? canon.hashNode(b, cur) : canon.hashNode(cur, b);
  });
  return cur.toString('hex');
}

/** The sides an honest prover would have carried, for the credulous verifier. */
function derivedSides(m, n, len) {
  const sides = [];
  let fn = m, sn = n - 1;
  for (let i = 0; i < len; i++) {
    if (fn % 2 === 1 || fn === sn) {
      sides.push('L');
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else sides.push('R');
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sides;
}

/* ══ the four real implementations, wrapped to one shape ══════════════════ */

const NA = Symbol('not expressible in this implementation');

const IMPLEMENTATIONS = [
  {
    key: 'lib/scruple/merkle.ts',
    construction: 'sorted-pair, duplicate-last, hex-ASCII concat, no domain separation',
    role: 'the root every /api/lock/* route computes today',
    root: (leaves) => scrupleMerkle.computeRootFromLeaves(leaves),
    verifyProof: () => NA,
    proofNote: 'HAS NO INCLUSION PROOF. Pair order comes from hash value, so there is no index to prove.',
  },
  {
    key: 'lib/witness/merkle.ts',
    construction: '0x01 leaf / 0x00 node, duplicate-last, raw bytes',
    role: 'the root lib/witness/checkpointScheduler.ts writes into log_checkpoints',
    root: (leaves) => witnessMerkle.buildBalancedMerkle(leaves).root, // throws on n=0; scoreRoots records that as a miss
    verifyProof: (proof) => {
      const sides = derivedSides(proof.leaf_index, proof.tree_size, proof.path.length);
      const p = proof.path.map((sibling, i) => ({ sibling, position: sides[i] }));
      try { return witnessMerkle.rootFromInclusion(proof.leaf_hash, p); } catch { return null; }
    },
    proofNote: 'emits {sibling, position} — the prover chooses the sides.',
  },
  {
    key: 'packages/scruple-verify/.../merkle.mjs',
    construction: 'COPY of lib/witness/merkle.ts, verification path only',
    role: 'what the shipped verifier CLI reconstructs a root with',
    root: () => NA,
    verifyProof: (proof) => {
      const sides = derivedSides(proof.leaf_index, proof.tree_size, proof.path.length);
      const p = proof.path.map((sibling, i) => ({ sibling, position: sides[i] }));
      try { return verifyMerkle.rootFromInclusion(proof.leaf_hash, p); } catch { return null; }
    },
    proofNote: 'verify-only; builds no tree.',
  },
  {
    key: 'witness server.js:483',
    construction: 'hex-ASCII concat, PROMOTE the odd one unchanged, no domain separation',
    role: `the deployed /opt/scruple-witness algorithm (byte-identical copy: ${witnessServer.identical === true ? 'CONFIRMED' : witnessServer.identical === false ? '🔴 DIFFERS — row is UNKNOWN' : 'not readable on this host'})`,
    root: (leaves) => witnessServer.fn(leaves),
    verifyProof: () => NA,
    proofNote: 'HAS NO INCLUSION PROOF at all — it returns a root and nothing else.',
    unknown: witnessServer.identical !== true,
  },
];

/* ══ scoring ═════════════════════════════════════════════════════════════ */

function scoreRoots(rootFn) {
  const res = { pass: 0, fail: 0, na: 0, failedSizes: [], passedSizes: [] };
  for (const vec of doc.canonical) {
    let got;
    try { got = rootFn(vec.leaves); } catch { got = null; }
    if (got === NA) { res.na++; continue; }
    if (got === vec.root) { res.pass++; res.passedSizes.push(vec.tree_size); }
    else { res.fail++; res.failedSizes.push(vec.tree_size); }
  }
  return res;
}

function scoreProofs(verifyFn) {
  const res = { pass: 0, fail: 0, na: 0, refusalPass: 0, refusalFail: 0 };
  for (const vec of doc.canonical) {
    for (const proof of vec.proofs) {
      let got;
      try { got = verifyFn(proof); } catch { got = null; }
      if (got === NA) { res.na++; continue; }
      if (got === vec.root) res.pass++; else res.fail++;
    }
  }
  for (const ref of doc.refused_proofs) {
    let got;
    try { got = verifyFn(ref.proof); } catch { got = null; }
    if (got === NA) { res.na++; continue; }
    if (got === ref.true_root) res.refusalFail++; else res.refusalPass++;
  }
  return res;
}

/* ══ the hand check — no Scruple code in the path ═════════════════════════ */

function handCheck() {
  const hc = doc.hand_check;
  const out = execFileSync('bash', ['-c', hc.shell], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  return { expected: hc.root, got: out, ok: out === hc.root, cmd: hc.shell };
}

/* ══ report ══════════════════════════════════════════════════════════════ */

const controlFailures = [];
const report = { generated_at: new Date().toISOString(), vectors: VECTORS, rows: [], controls: [] };

console.log('╔══ WO-C6 · MERKLE CONFORMANCE ══════════════════════════════════════════╗');
console.log(`vectors  : ${path.relative(REPO, VECTORS)}  (${doc.canonical.length} trees, ` +
  `${doc.canonical.reduce((a, c) => a + c.proofs.length, 0)} proofs, ${doc.refused_proofs.length} refusals)`);
console.log(`canonical: ${doc.algorithm.id}`);
console.log(`witness  : services/witness-server/server.js vs ${DEPLOYED_WITNESS} → ` +
  (witnessServer.identical === true ? 'BYTE-IDENTICAL (deployed algorithm executed from the repo copy)'
    : witnessServer.identical === false ? '🔴 DIFFER' : 'deployed copy not readable here'));
console.log('');

// --- the four real implementations -----------------------------------------
console.log('── THE ESTATE ─────────────────────────────────────────────────────────');
console.log('impl                                   roots        proofs       refusals');
for (const impl of IMPLEMENTATIONS) {
  const r = scoreRoots(impl.root);
  const p = scoreProofs(impl.verifyProof);
  const rootCell = r.na === doc.canonical.length ? 'n/a' : `${r.pass}/${r.pass + r.fail}`;
  const proofTotal = p.pass + p.fail;
  const proofCell = proofTotal === 0 ? 'n/a' : `${p.pass}/${proofTotal}`;
  const refTotal = p.refusalPass + p.refusalFail;
  const refCell = refTotal === 0 ? 'n/a' : `${p.refusalPass}/${refTotal}`;
  const verdict = (r.fail + p.fail + p.refusalFail) === 0 && (r.pass + p.pass) > 0 ? 'PASS' : 'FAIL';
  console.log(`${impl.key.padEnd(38)} ${rootCell.padEnd(12)} ${proofCell.padEnd(12)} ${refCell.padEnd(8)} ${verdict}`);
  console.log(`    ${impl.construction}`);
  console.log(`    ${impl.role}`);
  console.log(`    ${impl.proofNote}`);
  if (r.passedSizes.length && r.failedSizes.length) {
    console.log(`    roots agree at n=${r.passedSizes.join(',')} and differ at n=${r.failedSizes.join(',')}`);
  }
  report.rows.push({ impl: impl.key, roots: r, proofs: p, verdict });
}
// --- the estate against ITSELF -------------------------------------------
// The gate says: "a runner that cannot show the current three disagreeing has
// not been proven to work." Failing them all against the canonical rule is not
// that demonstration — this is. Each cell is how many of the vector trees the
// two implementations give the SAME root on.
console.log('── THE ESTATE AGAINST ITSELF (agreements out of ' + doc.canonical.length + ' trees) ──────────────');
// Which implementations build a tree at all (the verifier copy does not).
const rooters = IMPLEMENTATIONS.filter((i) => {
  try { return i.root(doc.canonical[1].leaves) !== NA; } catch { return true; }
});
const rootsOf = (impl, leaves) => { try { const r = impl.root(leaves); return r === NA ? undefined : r; } catch { return undefined; } };
for (let a = 0; a < rooters.length; a++) {
  for (let b = a + 1; b < rooters.length; b++) {
    const agree = doc.canonical.filter((v) => {
      const x = rootsOf(rooters[a], v.leaves), y = rootsOf(rooters[b], v.leaves);
      return x !== undefined && x !== null && x === y; // null==null is not agreement
    });
    console.log(`${rooters[a].key.padEnd(26)} vs ${rooters[b].key.padEnd(26)} ${String(agree.length).padStart(2)}/${doc.canonical.length}` +
      (agree.length ? `  (agree at n=${agree.map((v) => v.tree_size).join(',')})` : ''));
  }
}
{
  // ⚑ AND THE TRAP THE VECTOR FILE WAS BUILT TO AVOID. With leaves in
  // ASCENDING order, sorting a pair is a no-op, so sorted-pair and plain
  // concat coincide at every size where neither pads. A vector file that
  // happened to use ascending leaves would have reported two of the three
  // implementations agreeing and would have been read as evidence.
  const asc = (n) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, '0').repeat(32));
  const sizes = [1, 2, 4, 8];
  const same = sizes.filter((n) => scrupleMerkle.computeRootFromLeaves(asc(n)) === witnessServer.fn(asc(n)));
  console.log('');
  console.log(`⚑ CONTROL ON THE VECTOR SET ITSELF: with ASCENDING leaves, lib/scruple/merkle.ts and`);
  console.log(`  witness server.js agree at n=${same.join(',')} of ${sizes.join(',')} — sorting an already-sorted`);
  console.log(`  pair is a no-op. Every leaf set in the vector file is descending or shuffled for`);
  console.log(`  exactly this reason; an ascending vector file would have hidden this divergence.`);
  if (same.length === 0) controlFailures.push('the ascending-leaf coincidence no longer reproduces — the vector-set rationale needs rechecking');
  report.controls.push({ control: 'ascending-leaf-trap', ok: same.length > 0, agreeAt: same });
}
console.log('');

console.log('');

// --- controls that MUST PASS ------------------------------------------------
console.log('── CONTROLS THAT MUST PASS ────────────────────────────────────────────');
{
  const r = scoreRoots(canon.merkleRoot);
  const p = scoreProofs((proof) => { try { return canon.rootFromProof(proof); } catch { return null; } });
  const ok = r.fail === 0 && p.fail === 0 && p.refusalFail === 0;
  console.log(`canonical spec        roots ${r.pass}/${r.pass + r.fail}  proofs ${p.pass}/${p.pass + p.fail}  refusals ${p.refusalPass}/${p.refusalPass + p.refusalFail}  ${ok ? 'PASS' : '🔴 FAIL'}`);
  if (!ok) controlFailures.push('the canonical spec does not pass its own vectors');
  report.controls.push({ control: 'canonical-spec', mustPass: true, ok });
}
{
  let ok = false, out = '';
  try {
    out = execFileSync('python3', [path.join(HERE, 'merkle_canonical.py')], { encoding: 'utf8', cwd: REPO });
    ok = /ALL PASS/.test(out);
  } catch (e) { out = String(e.stdout || e.message); }
  console.log(`python (independent)  ${ok ? 'PASS' : '🔴 FAIL'}  — ${out.trim().split('\n')[0]}`);
  if (!ok) controlFailures.push('the independent Python implementation does not reach the vectors');
  report.controls.push({ control: 'python-independent', mustPass: true, ok });
}
{
  const hc = handCheck();
  console.log(`shell hand-check      ${hc.ok ? 'PASS' : '🔴 FAIL'}  — ${hc.cmd}`);
  console.log(`                      ${hc.got}`);
  if (!hc.ok) controlFailures.push('the shell hand-check does not reproduce the n=1 canonical root');
  report.controls.push({ control: 'shell-hand-check', mustPass: true, ok: hc.ok });
}
console.log('');

// --- controls that MUST FAIL ------------------------------------------------
console.log('── CONTROLS THAT MUST FAIL (a runner that cannot fail proves nothing) ─');
for (const mut of MUTANTS) {
  const r = scoreRoots(mut.root);
  const failed = r.fail > 0;
  let ok = failed;
  let extra = '';
  if (mut.key === 'dup-last') {
    // PRECISION, not blanket: this mutant must pass at powers of two and fail
    // elsewhere. A runner that simply fails everything goes red right here.
    const pow2 = (x) => x > 0 && (x & (x - 1)) === 0;
    const wrongPasses = r.passedSizes.filter((n) => !pow2(n) && n !== 0);
    const wrongFails = r.failedSizes.filter((n) => pow2(n) || n === 0);
    ok = failed && wrongPasses.length === 0 && wrongFails.length === 0;
    extra = ` (agrees at n=${r.passedSizes.join(',')}; differs at n=${r.failedSizes.join(',')})`;
    if (!ok) controlFailures.push(`mutant dup-last did not discriminate by size: unexpected pass ${wrongPasses} / unexpected fail ${wrongFails}`);
  } else if (!failed) {
    controlFailures.push(`mutant ${mut.key} was not caught by the vectors`);
  }
  console.log(`mutant ${mut.key.padEnd(16)} roots ${r.pass}/${r.pass + r.fail}  ${ok ? 'caught' : '🔴 NOT CAUGHT'}${extra}`);
  console.log(`    ${mut.why}`);
  report.controls.push({ control: `mutant:${mut.key}`, mustFail: true, ok });
}
{
  // Honest proofs: it derives the sides itself and must agree everywhere.
  let honestPass = 0, honestFail = 0;
  for (const vec of doc.canonical) {
    for (const proof of vec.proofs) {
      const sides = derivedSides(proof.leaf_index, proof.tree_size, proof.path.length);
      if (credulousVerifier(proof, sides) === vec.root) honestPass++; else honestFail++;
    }
  }
  // Forgeries: the attacker supplies the sides of the honest proof it was
  // built from, because those are the ones that reproduce the true root.
  const accepted = [];
  for (const ref of doc.refused_proofs) {
    const o = ref.origin;
    const sides = derivedSides(o.leaf_index, o.tree_size, ref.proof.path.length);
    let got;
    try { got = credulousVerifier(ref.proof, sides); } catch { got = null; }
    if (got === ref.true_root) accepted.push(ref.name);
  }
  const ok = honestFail === 0 && accepted.length > 0;
  console.log(`mutant ${'carried-sides'.padEnd(16)} proofs ${honestPass}/${honestPass + honestFail}  ` +
    `refusals ${doc.refused_proofs.length - accepted.length}/${doc.refused_proofs.length}  ${ok ? 'caught' : '🔴 NOT CAUGHT'}`);
  console.log('    consumes the {sibling, position} shape lib/witness/merkle.ts emits, canonical tags,');
  console.log('    sides taken from the proof instead of derived from (leaf_index, tree_size)');
  console.log(`    → agrees with the canonical verifier on ${honestPass}/${honestPass + honestFail} HONEST proofs`);
  console.log(`    → but ACCEPTS ${accepted.length} of ${doc.refused_proofs.length} forgeries:`);
  for (const a of accepted) console.log(`        · ${a}`);
  console.log('    Exactly the structural ones. Carrying the sides loses the index and tree-size');
  console.log('    binding and nothing else — which is precisely the binding the design requires.');
  if (honestFail > 0) controlFailures.push('the carried-sides verifier disagreed on an honest proof; the comparison is not like-for-like');
  if (accepted.length === 0) controlFailures.push('the carried-sides verifier accepted no forgery, so the refusal vectors do not test the format at all');
  report.controls.push({ control: 'mutant:carried-sides', mustFail: true, ok, acceptedForgeries: accepted });
}
console.log('');

// --- verdict ---------------------------------------------------------------
const passing = report.rows.filter((r) => r.verdict === 'PASS').map((r) => r.impl);
console.log('── VERDICT ────────────────────────────────────────────────────────────');
console.log(`implementations passing the shared vectors: ${passing.length ? passing.join(', ') : 'NONE'}`);
console.log(`Appendix C item 0 condition met: ${passing.length === IMPLEMENTATIONS.length ? 'YES' : 'NO'}`);
console.log(`→ CHECKPOINT_VECTORS_SETTLED must remain ${passing.length === IMPLEMENTATIONS.length ? 'reviewable' : 'false'}; every leaf keeps saying \`stale\`.`);
if (controlFailures.length) {
  console.log('');
  console.log('🔴 CONTROL FAILURES — the runner itself is not trustworthy:');
  for (const f of controlFailures) console.log(`   - ${f}`);
}
console.log('╚════════════════════════════════════════════════════════════════════════╝');

// `--json` appends a machine-readable matrix after a marker line. The pinning
// test in test/v2 compares the NUMBERS: an earlier draft grepped for the words
// "passing the shared vectors: NONE", and a control run showed that phrase
// surviving unchanged while lib/witness/merkle.ts went from 0/10 to 9/10 — it
// still missed the empty tree, so it still was not "passing". A verdict word
// that cannot see a nine-out-of-ten change is not a pin.
if (process.argv.includes('--json')) {
  console.log('===JSON===');
  console.log(JSON.stringify(report));
}

process.exit(controlFailures.length ? 1 : 0);
