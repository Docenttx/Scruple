// WO-C6 — the shared Merkle vectors, and the matrix they currently produce.
//
// ⚑ THIS TEST PINS A FAILURE. It asserts that the four live root calculations
// do NOT pass `test/vectors/merkle-vectors.json`, because on 2026-09-09 none
// of them does and Appendix C item 0 makes that the reason every leaf says
// `stale`. A test that asserted they passed would be green only after the
// cutover; a test that asserted nothing would let the divergence be closed, or
// widened, without anybody noticing.
//
// So it goes RED in both directions:
//   - if someone changes a root calculation and the matrix moves, and
//   - if the runner stops being able to discriminate (its own controls).
//
// When the cutover (WO-C7) lands, this file's expectations change in the same
// commit as the implementations, and `CHECKPOINT_VECTORS_SETTLED` flips in the
// same commit as this file. Those three moving together is the point.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Score = { pass: number; fail: number; refusalPass: number; refusalFail: number };
type MatrixRow = { impl: string; roots: Score; proofs: Score; verdict: string };
type ControlRow = { control: string; ok: boolean };

const REPO = path.join(__dirname, '..', '..');
const VECTORS = path.join(REPO, 'test', 'vectors', 'merkle-vectors.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc: any = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

describe('WO-C6 — the shared vector file', () => {
  test('exists, and names one canonical construction', () => {
    assert.equal(doc.algorithm.id, 'scruple-merkle-rfc6962-sha256-v1');
    assert.equal(doc.algorithm.merkle_version, 1);
    assert.equal(doc.algorithm.leaf_preimage, '0x00 || <32 raw bytes of leaf_hash>');
    assert.match(doc.algorithm.odd_levels, /NEVER duplicate the last leaf/);
    assert.match(doc.algorithm.proof_format, /carries NO L\/R sides/);
  });

  test('the version stamp is documented as forward insurance, not a legacy path', () => {
    // The founder's 2026-09-09 correction. If this sentence ever softens, a
    // later reader takes the stamp as evidence that a version 0 existed and
    // reintroduces the dual-rule scheme the correction removed.
    assert.match(doc.algorithm.version_stamp_purpose, /FORWARD INSURANCE ONLY/);
    assert.match(doc.algorithm.version_stamp_purpose, /no version 0 and there never was one/);
  });

  test('no leaf set is in ascending order — an ascending set hides the divergence', async () => {
    // Measured before the file existed: ascending leaves make sorted-pair a
    // no-op, so lib/scruple/merkle.ts and the witness server coincide. A
    // vector file that drifted back to ascending leaves would go on passing
    // while proving less, which is the exact failure this series refuses.
    for (const vec of doc.canonical) {
      if (vec.leaves.length < 2) continue;
      const sorted = [...vec.leaves].sort();
      assert.notDeepEqual(vec.leaves, sorted, `${vec.name} is in ascending order`);
    }
  });

  test('every canonical root recomputes from the spec', async () => {
    const canon = await import(path.join(REPO, 'scripts', 'merkle-canonical-spec.mjs'));
    for (const vec of doc.canonical) {
      assert.equal(canon.merkleRoot(vec.leaves), vec.root, vec.name);
      for (const proof of vec.proofs) {
        assert.equal(canon.rootFromProof(proof), vec.root, `${vec.name}[${proof.leaf_index}]`);
      }
    }
  });

  test('every refusal is refused, and the one the walk cannot refuse still verifies', async () => {
    const canon = await import(path.join(REPO, 'scripts', 'merkle-canonical-spec.mjs'));
    for (const ref of doc.refused_proofs) {
      let reached = false;
      try { reached = canon.rootFromProof(ref.proof) === ref.true_root; } catch { reached = false; }
      assert.equal(reached, false, `refusal did not refuse: ${ref.name}`);
    }
    // The mirror. `tree_size` inside a full subtree is invisible to the walk,
    // so the VERIFIER must compare it against the checkpoint record. Asserted
    // rather than commented, or a later "hardening" of the walk breaks honest
    // proofs while this file stays green.
    for (const nr of doc.not_refusable_by_walk) {
      assert.equal(canon.rootFromProof(nr.proof) === nr.true_root, nr.verifies_under_the_walk, nr.name);
    }
  });

  test('duplicate-last is ambiguous and the canonical rule is not', async () => {
    const canon = await import(path.join(REPO, 'scripts', 'merkle-canonical-spec.mjs'));
    const witness = await import(path.join(REPO, 'lib', 'witness', 'merkle.ts'));
    for (const amb of doc.ambiguity) {
      // CVE-2012-2459, measured against the implementation that has it.
      assert.equal(
        witness.buildBalancedMerkle(amb.leaves_a).root,
        witness.buildBalancedMerkle(amb.leaves_b).root,
        `${amb.name}: lib/witness/merkle.ts was expected to COLLIDE here`,
      );
      assert.notEqual(canon.merkleRoot(amb.leaves_a), canon.merkleRoot(amb.leaves_b), amb.name);
    }
  });
});

describe('WO-C6 — the estate, as measured 2026-09-09', () => {
  test('the deployed witness algorithm is byte-identical to the in-repo copy', () => {
    // The runner executes the repo copy and calls it the deployed algorithm.
    // That claim is only true while this holds, and /opt is never written.
    const repo = fs.readFileSync(path.join(REPO, 'services', 'witness-server', 'server.js'));
    let deployed: Buffer | null = null;
    try { deployed = fs.readFileSync('/opt/scruple-witness/server.js'); } catch { deployed = null; }
    if (deployed === null) return; // not this host; the runner reports UNKNOWN
    assert.ok(repo.equals(deployed), 'services/witness-server/server.js has drifted from /opt/scruple-witness');
  });

  // One runner invocation, reused. `--json` appends a machine-readable matrix.
  const runner = (): { rows: MatrixRow[]; controls: ControlRow[]; text: string } => {
    const text = execFileSync('node', ['--import', 'tsx', path.join(REPO, 'scripts', 'merkle-conformance.mjs'), '--json'],
      { encoding: 'utf8', cwd: REPO });
    const json = text.slice(text.lastIndexOf('===JSON===') + '===JSON==='.length);
    return { ...JSON.parse(json), text };
  };

  test('the matrix is EXACTLY what was measured on 2026-09-09', () => {
    // ⚑ NUMBERS, NOT A VERDICT WORD. The first draft of this test asserted the
    // runner printed "passing the shared vectors: NONE". A control run then
    // made lib/witness/merkle.ts canonical and that phrase did not move —
    // the implementation went from 0/10 to 9/10 and still missed the empty
    // tree, so it still was not "passing". A pin that cannot see a
    // nine-out-of-ten change is not a pin. Every cell is asserted.
    const { rows } = runner();
    const cell = (r: MatrixRow) => [
      r.impl,
      `${r.roots.pass}/${r.roots.pass + r.roots.fail}`,
      `${r.proofs.pass}/${r.proofs.pass + r.proofs.fail}`,
      `${r.proofs.refusalPass}/${r.proofs.refusalPass + r.proofs.refusalFail}`,
      r.verdict,
    ].join(' ');
    assert.deepEqual(rows.map(cell), [
      // roots  proofs  refusals — 0/0 means the implementation cannot express it
      'lib/scruple/merkle.ts 0/10 0/0 0/0 FAIL',
      'lib/witness/merkle.ts 0/10 0/45 6/6 FAIL',
      'packages/scruple-verify/.../merkle.mjs 0/0 0/45 6/6 FAIL',
      'witness server.js:483 0/10 0/0 0/0 FAIL',
    ]);
  });

  test('the runner discriminates — every control lands the right way round', () => {
    // Without this the matrix above is satisfied by a runner that reports
    // failure unconditionally, which is a green test with no control.
    const { controls, text } = runner();
    for (const c of controls) assert.equal(c.ok, true, `control did not land: ${c.control}`);
    assert.deepEqual(controls.map((c) => c.control), [
      'ascending-leaf-trap', 'canonical-spec', 'python-independent', 'shell-hand-check',
      'mutant:tags-swapped', 'mutant:no-domain-sep', 'mutant:dup-last',
      'mutant:hex-preimage', 'mutant:carried-sides',
    ]);
    // The precision check: dup-last must AGREE at powers of two and differ
    // elsewhere. A blanket-fail runner fails this line, not the ones above.
    assert.match(text, /mutant dup-last .*caught \(agrees at n=0,1,2,4,8; differs at n=3,5,7,9,100\)/);
    // And the proof-format argument, measured rather than argued: dropping
    // `position` costs nothing on honest proofs and buys back exactly the two
    // structural forgeries.
    assert.match(text, /agrees with the canonical verifier on 45\/45 HONEST proofs/);
    assert.match(text, /ACCEPTS 2 of 6 forgeries/);
    assert.match(text, /Appendix C item 0 condition met: NO/);
  });

  test('CHECKPOINT_VECTORS_SETTLED is still false, and this is why', async () => {
    const { CHECKPOINT_VECTORS_SETTLED } = await import('@/lib/leaf/attestationBasis');
    assert.equal(CHECKPOINT_VECTORS_SETTLED, false);
  });
});
