# WO-C6 — the canonical Merkle: a plan, shared vectors, and a runner

_2026-09-09. Implements WO-C6 of `docs/wo/2026-09-09-council-implementation.md`
against Appendix C item 0 of `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
— the one release blocker that survived all four seats settling. Sandbox only.
🔴 **`/opt/scruple-witness` was READ and never written.** Its `server.js` mtime
is 2026-09-02 03:48, before this series began; `00-baseline.txt` records the
`find -printf` proving it, and `06-suites-after.txt` was taken after every run.
No root calculation changed._

**GATE: PASSED.** The vector file exists
(`test/vectors/merkle-vectors.json`), the runner
(`scripts/merkle-conformance.mjs`) executes it against all three live
constructions plus the verifier copy, and the report below states plainly which
pass and which fail: **none of the four passes.** `CHECKPOINT_VECTORS_SETTLED`
therefore stays `false` and every leaf keeps saying `stale` — WO-C6 does not
lift the blocker, it makes the blocker measurable and says exactly what lifting
it costs.

---

## 1 · What was measured, before anything was written

`01-divergence.txt`. One leaf set, three implementations, executed rather than
read:

| n | `lib/scruple/merkle.ts` | `lib/witness/merkle.ts` | witness `server.js:483` | distinct |
|---|---|---|---|---|
| 1 | `0101…0101` | `ce041765…` | `0101…0101` | 2 of 3 |
| 2 | `7619ddd5…` | `1846f34e…` | `7619ddd5…` | 2 of 3 |
| 3 | `ba2ec9ff…` | `2a7e43c8…` | `52be867b…` | **3 of 3** |
| 4 | `da7d67dc…` | `4f0a4a50…` | `da7d67dc…` | 2 of 3 |
| 5 | `64733f28…` | `2bf51e42…` | `dcb6073a…` | **3 of 3** |

⚑ **AND THE TRAP IN THAT TABLE, WHICH DECIDED THE SHAPE OF THE VECTOR FILE.**
Those leaves are in ASCENDING hex order, and at n = 1, 2, 4 the sorted-pair
implementation and the plain-concat one **agree** — sorting an already-sorted
pair is a no-op. Re-run descending (`01-divergence.txt`, second half) and the
agreement disappears at every size but n=1.

A vector file built from `sha256("leaf1"), sha256("leaf2"), …` in whatever
order they came out would therefore have shown two of the three implementations
agreeing, and that would have been read as evidence that only one was wrong. So
**every leaf set in `merkle-vectors.json` is descending or shuffled**, and
`test/v2/merkle-conformance.test.ts` asserts that no leaf set is ascending. The
runner prints the coincidence as a standing control, so if the vector set ever
drifts back the reason it was built that way is still on screen.

## 2 · The canonical construction

`scripts/merkle-canonical-spec.mjs` and `scripts/merkle_canonical.py` are two
implementations of one written rule. The rule:

| | |
|---|---|
| **algorithm id** | `scruple-merkle-rfc6962-sha256-v1` |
| **reference** | RFC 6962 §2.1 (MTH), §2.1.1 (PATH), §2.1.2 (verification walk) |
| **leaf preimage** | `0x00 ‖ <32 RAW bytes of leaf_hash>` — never the 64-char ASCII hex |
| **node preimage** | `0x01 ‖ <32 bytes left> ‖ <32 bytes right>` |
| **empty tree** | `SHA-256()` = `e3b0c442…b855` |
| **odd levels** | split at `k` = largest power of two **strictly less than** `n`. **Never duplicate the last leaf.** |
| **leaf order** | ascending `tenant_seq` across `[first_seq, last_seq]`; gaps and duplicates refused before the tree is built |
| **proof** | `{merkle_version, checkpoint_id, tree_size, leaf_index, leaf_hash, path[]}`, `path` bottom-up (leaf-adjacent sibling first), **no L/R sides** |

### Why RFC 6962 is forced rather than chosen

The design requires an inclusion proof over `(checkpoint_id, index, leaf_hash)`.
A sorted-pair tree pairs by hash **value**, so a proof shows membership and is
silent about position: `lib/scruple/merkle.ts` cannot carry an index at all,
whatever else it does. That eliminates it on a requirement. Of what remains,
RFC 6962 is the only published construction with domain separation, a defined
proof format, and third-party verifiers that already exist.

### The one decision that is not RFC boilerplate: the proof carries no sides

`lib/witness/merkle.ts` emits `{sibling, position: 'L' | 'R'}`. If the prover
chooses the sides, the verifier checks a path the prover shaped and `leaf_index`
is decoration. In the canonical format the sides are **derived** from
`(leaf_index, tree_size)` by the §2.1.2 walk, so a proof that verifies proves
the leaf sits **at that index in a tree of that size**.

This is measured, not argued. The runner's fifth mutant is a verifier identical
to the canonical one except that it trusts carried sides, and the vector file
hands it the sides an attacker would have supplied (`origin` on each refusal):

```
mutant carried-sides    proofs 45/45  refusals 4/6  caught
    → agrees with the canonical verifier on 45/45 HONEST proofs
    → but ACCEPTS 2 of 6 forgeries:
        · a valid path presented under a DIFFERENT leaf_index
        · the LAST leaf of a ragged tree presented under a DIFFERENT tree_size
```

Carrying the sides costs nothing on honest proofs and loses exactly the index
and tree-size binding — which is precisely the binding the design asked for.

### ⚑ What the walk alone does NOT refuse — found by the control, not by reading

A first draft of the `tree_size` refusal used leaf index 3 of a 7-leaf tree and
presented it as `tree_size: 8`. The Python recomputation reported it as a
**failed refusal**: the proof verified. It should have. Index 3 sits inside the
full left 4-leaf subtree of both trees, so every derived side is identical and
the walk reproduces the root either way. A `tree_size` the walk cannot
contradict is one the walk cannot check.

The consequence is a **requirement on the verifier**, now recorded as a
first-class vector class (`not_refusable_by_walk`) and asserted in both
languages: **`tree_size` and the recomputed root must BOTH be compared against
the checkpoint record.** A verifier that runs the walk and stops there accepts a
proof carrying a `tree_size` no checkpoint ever had. The refusal vector was
moved to index 6, the ragged one, where the path length genuinely differs.

## 3 · Four differences from the implementation that calls itself RFC 6962

`lib/witness/merkle.ts` is the closest of the three and it still fails every
vector. Each difference changes the root:

1. **The tags are swapped.** RFC 6962 §2.1 is `0x00` leaf / `0x01` node. The
   file uses `0x01` leaf / `0x00` node. Domain separation still holds, but no
   off-the-shelf CT verifier agrees with it and a reader checking it against the
   RFC finds a mismatch with no note saying it was deliberate.
2. **Duplicate-last instead of the split — and it is CVE-2012-2459.** Measured,
   in `test/v2/merkle-conformance.test.ts`:
   `buildBalancedMerkle([a,b,c]).root === buildBalancedMerkle([a,b,c,c]).root`.
   Two different leaf sets, one root. One anchored root would attest to two
   different histories, and an inclusion proof for the phantom leaf verifies.
   **This is a live second-preimage weakness in the implementation the
   checkpoint scheduler uses today**, not a stylistic difference, and it is why
   "the canonical choice is forced" does not mean "the survivor is already
   correct".
3. **The leaf preimage.** Raw bytes here; two of the three live constructions
   hash ASCII hex.
4. **The proof format**, §2 above.

⚑ **And a fifth that changes no root but breaks any third party.** Both
`lib/witness/merkle.ts` and `packages/scruple-verify/src/core/merkle.mjs`
document their inclusion path as *"top-down (root ⇒ leaf)"*. Read the code:
index 0 is the leaf's own sibling and `rootFromInclusion` consumes it starting
at the leaf. **Both are bottom-up and both comments are wrong.** Anyone
implementing a verifier from the comment rather than the code produces reversed
proofs. Fixed in the canonical spec by stating the direction and shipping
vectors that pin it.

## 4 · The matrix, today

`04-conformance.txt`, reproduced by `npm run merkle:conformance`:

```
── THE ESTATE ─────────────────────────────────────────────────────────
impl                                   roots        proofs       refusals
lib/scruple/merkle.ts                  0/10         n/a          n/a      FAIL
lib/witness/merkle.ts                  0/10         0/45         6/6      FAIL
packages/scruple-verify/.../merkle.mjs n/a          0/45         6/6      FAIL
witness server.js:483                  0/10         n/a          n/a      FAIL

── THE ESTATE AGAINST ITSELF (agreements out of 10 trees) ─────────────
lib/scruple/merkle.ts      vs lib/witness/merkle.ts       0/10
lib/scruple/merkle.ts      vs witness server.js:483       1/10  (agree at n=1)
lib/witness/merkle.ts      vs witness server.js:483       0/10
```

**None of the four passes. No two of them agree on more than one tree.** The
`refusals 6/6` cells are not credit: an implementation that cannot verify a
canonical proof at all refuses every forgery by refusing everything.

Two of the four **have no inclusion proof of any kind** —
`lib/scruple/merkle.ts` by construction, and the deployed witness server because
`calculateMerkleRoot` returns a root and nothing else. The design's
`(checkpoint_id, index, leaf_hash)` resolution has no implementation on the
witness side today.

🔴 **And the fact that makes "the root" undefined rather than merely
inconsistent.** `services/witness-server/server.js:911` —
`const merkle_root = bodyMerkleRoot || calculateMerkleRoot(hashes)`. The witness
anchors **whichever root the caller supplies**, falling back to its own. The
algorithm behind an anchored root is caller-dependent, so no verifier can know
which rule to check it under. That line is the cutover's first target and it is
in `/opt`, which is why WO-C6 stops at a plan.

## 5 · Which of the three survives, and what gets deleted

**A cutover, not a migration.** Per the founder's 2026-09-09 correction there
are no real provenance packages — every anchored artefact to date is test work
— so there is no dual-rule scheme, no legacy verification path and no
per-record compatibility branch. One construction survives and the others are
deleted.

**Survivor: `lib/witness/merkle.ts`, rewritten to the canonical rule.** It is
the file the checkpoint scheduler and the `/api/v1/proof` route already use; it
is the only one already in bytes with domain separation; and it is the only one
on the checkpoint path the design actually depends on. It survives as a
**location**, not as an algorithm — all four differences in §3 are changes to
it.

| file | disposition |
|---|---|
| `lib/witness/merkle.ts` | **REWRITE** to canonical: tags `0x00`/`0x01`, RFC split, `{tree_size, leaf_index, path[]}` proofs, no `position` |
| `packages/scruple-verify/src/core/merkle.mjs` | **REWRITE** as the verification half of the same rule; keep the COPY discipline in its header |
| `lib/scruple/merkle.ts` | **DELETE.** Cannot bind an index; no domain separation; hashes ASCII hex |
| `research/electron-source/lock/merkle.js` and `research/electron-source/scruple-studio/scruple-studio/lock/merkle.js` | **DELETE** (byte-identical to each other, `md5 04f0702b…`; the ancestor `lib/scruple/merkle.ts` was ported from) |
| `scripts/audit-receipts.py` → `build_merkle` | **DELETE.** A fourth copy, in Python, of the losing rule — its own comment says *"Replicate /data/scruple-web/lib/scruple/merkle.ts"* |
| `services/witness-server/server.js` → `calculateMerkleRoot` | **DELETE**, replaced by the canonical builder. 🔴 requires a deploy to `/opt/scruple-witness`, which no WO in this series may perform |

⚑ **A wrong implementation left in the tree is a future caller's default.**
`lib/scruple/merkle.ts` currently has five importers — `app/api/verify`,
`app/api/lock/{chain,local,checkpoint}` and `app/api/stripe/confirm` — so
deleting it is a code change in five routes, not a file removal. That work is
the bulk of the cutover and is listed in §6.

## 6 · The cutover — WO-C7

Not performed here. In order, because each step's evidence is the next step's
input:

1. **Rewrite `lib/witness/merkle.ts`** to the canonical rule and move
   `scripts/merkle-canonical-spec.mjs` into it. Delete the spec file — one
   construction, one location. `test/v2/merkle-conformance.test.ts` moves that
   row from `0/10 FAIL` to `10/10 PASS` **in the same commit**.
2. **Rewrite `packages/scruple-verify/src/core/merkle.mjs`** and
   `src/cli.mjs:203`, which reconstructs a root from `proof.inclusion`. The
   proof shape changes; the CLI must reject the old shape rather than coerce it.
3. **Migrate the five `lib/scruple/merkle.ts` importers** onto the canonical
   builder, then delete the file and its three replicas. Re-record
   `test/v2/watermark-chain.test.ts`, which pins roots from it.
4. **`/api/v1/proof/leaf/…`** emits the new proof shape, including `tree_size`
   and `leaf_index`, and the resolver compares both against the checkpoint
   record — see the `not_refusable_by_walk` finding in §2.
5. **Migration 058**: `merkle_version` and `merkle_algorithm` columns on
   `log_checkpoints`, and a `canonicalCheckpointV2.ts` carrying `merkle_version`
   inside the signed bundle. `CHECKPOINT_V1_FIELD_ORDER` is marked DO NOT MUTATE
   and is honoured — v2 is a new module, not an edited one.
6. **The witness server.** `calculateMerkleRoot` is replaced, and
   `server.js:911`'s `bodyMerkleRoot || …` is **deleted outright** — the server
   computes the root it anchors, or it anchors nothing. 🔴 This is the only step
   that touches `/opt/scruple-witness`. It is a deploy, it needs the founder,
   and it is out of scope for every WO in this series.
7. **Flip `CHECKPOINT_VECTORS_SETTLED`** in `lib/leaf/attestationBasis.ts` and
   `packages/scruple-api/scruple_api/attestation_basis.py` — **and only after
   `npm run merkle:conformance` reports all four passing.** Both constants move
   in one commit with the matrix expectations in
   `test/v2/merkle-conformance.test.ts`. Those three moving together is what
   stops the flag from being flipped on a promise.

Steps 1–5 are ours. Step 6 is a founder decision. **Step 7 must not precede
step 6**: a verifier that agrees with a witness that still anchors a
caller-supplied root has settled nothing.

## 7 · `merkle_version` is forward insurance, and there is no version 0

Stamped on each checkpoint record (§6 step 5) and inside each proof. Its purpose
is that a change to the construction made **after real packages exist** is
survivable.

**It is not compatibility with anything.** There is no version 0 and there never
was one — every artefact anchored before 2026-09-09 is test work and is being
discarded, not migrated. Said here, in
`test/vectors/merkle-vectors.json → algorithm.version_stamp_purpose`, and
asserted by a test, because a version field is exactly the kind of thing a later
reader takes as evidence that a legacy path once existed and then rebuilds the
dual-rule scheme the founder's correction removed.

## 8 · How the gate was verified, and every control that had to fire

The WO's own words: *"a runner that cannot show the current three disagreeing
has not been proven to work."* Failing all four against the canonical rule is
not that demonstration — a broken runner does that too. So the same run carries
rows that must pass and rows that must fail, and
`scripts/merkle-conformance.mjs` **exits non-zero if any control lands the wrong
way round**, whatever the four implementations do.

### The control that did NOT fire — the one that matters most

`02-testv2-before.txt`: before this WO, **`npm run test:v2` was 808 passing, 0
failing, while three Merkle constructions disagreed on every tree.** The only
Merkle test in the suite, `test/v2/watermark-chain.test.ts`, exercises
`lib/scruple/merkle.ts` against itself. A whole green suite, and nothing in it
could see the release blocker. That is the shape of the failure this series
exists to refuse, sitting in our own repository.

### Controls that must PASS (`04-conformance.txt`)

| control | result |
|---|---|
| the canonical spec against its own vectors | roots 10/10, proofs 45/45, refusals 6/6 |
| `scripts/merkle_canonical.py` — an **independent** implementation from the RFC text, which **must not read the roots out of the file** | 64 checks, ALL PASS |
| a shell hand-check with no Scruple code in the path — `printf … \| xxd -r -p \| sha256sum` | reproduces the n=1 root |

The Python is the repo's existing vector discipline (`gen-retention-policy-vectors.mjs`
header) and it earned its keep immediately: **it is what caught the bad
`tree_size` refusal in §2.** A vector file checked only by its own generator
would have shipped that as a passing refusal.

### Controls that must FAIL

| mutant | must | result |
|---|---|---|
| `tags-swapped` (`0x01`/`0x00` — the order `lib/witness/merkle.ts` uses) | fail | caught, 1/10 |
| `no-domain-sep` | fail | caught, 1/10 |
| `dup-last` | **fail ONLY at non-powers of two** | caught — agrees at n=0,1,2,4,8; differs at n=3,5,7,9,100 |
| `hex-preimage` | fail | caught, 1/10 |
| `carried-sides` | pass honest proofs, accept forgeries | 45/45 honest, **accepts 2 of 6 forgeries** |

`dup-last` is the precision check rather than a blanket one: **a runner that
simply failed everything would fail it at n=4 and the run would go red.** The
1/10 in three rows is the empty tree, which no tag choice affects.

### The three RED-before/green-after runs (`05-controls-red.txt`)

1. **The canonical spec broken** (leaf tag → `0x07`): runner prints
   `🔴 CONTROL FAILURES — the runner itself is not trustworthy`, **exits 1**;
   the pinning test goes 6 pass / 4 fail. Restored → exit 0.
2. **`lib/witness/merkle.ts` silently made canonical** — the cutover happening
   without the doc or the flag. Matrix moves `0/10 → 9/10`; pinning test 8/2.
   Restored → 10/10 green.
   ⚑ **This control found a defect in my own test.** The first draft asserted
   the runner printed *"passing the shared vectors: NONE"* — and **that phrase
   did not move**, because the mutated implementation still missed the empty
   tree and so still was not "passing". A pin that cannot see a nine-out-of-ten
   change is not a pin. The test now compares every cell of the matrix as
   numbers, via the runner's `--json` output, and the same control run turns it
   red. Recorded because the fix came from running the control, not from
   reviewing the test.
3. **The vector set regenerated ASCENDING**: the sorted-pair and concat
   implementations start coinciding (`2/10`, at n=1,2) and the
   `no leaf set is in ascending order` test goes red. Restored → green.

## 9 · Files

| file | what it is |
|---|---|
| `test/vectors/merkle-vectors.json` | **the shared vectors.** 10 trees, 45 proofs, 6 refusals, 1 not-refusable-by-walk, 2 ambiguity pairs |
| `scripts/merkle-canonical-spec.mjs` | the construction. Under `scripts/`, not `lib/`, so it cannot become a fourth live implementation before the cutover. Deleted by WO-C7 step 1 |
| `scripts/merkle_canonical.py` | the independent recomputation, and the cross-language half of "witness and verifier pass shared vectors" |
| `scripts/gen-merkle-vectors.mjs` | the generator. `npm run gen:merkle-vectors` |
| `scripts/merkle-conformance.mjs` | the runner. `npm run merkle:conformance`. Reads `/opt/scruple-witness/server.js` only to assert byte-identity with the in-repo copy it actually executes; starts no server and opens no database |
| `test/v2/merkle-conformance.test.ts` | pins the matrix, the controls, and the ascending-leaf rule into `npm run test:v2` |

## 10 · Two things found on the way that are not WO-C6, said plainly

**(a) `npm run test:v2` was silently not running a test file.** Its glob was
`ls test/v2/*.test.ts | grep -v conformance.test.ts` — an unanchored substring
filter, which excluded the new `test/v2/merkle-conformance.test.ts` along with
the intended `test/v2/conformance.test.ts`. The suite reported **808 passing
before and after the file was added**. Fixed to `grep -vx
test/v2/conformance.test.ts`; the suite now runs 34 files and reports 818.
Any future `*conformance.test.ts` would have been swallowed the same way.

**(b) Two host-SDK tests are RED, and they were red before this WO.** Proved on
a clean worktree at `HEAD` (`git worktree add … HEAD`, same two failures), so
WO-C6 did not cause them and does not fix them:

```
FAILED tests/test_model_write.py::test_the_dataset_lands_on_input_hash_with_the_shipped_formula
FAILED tests/test_model_write.py::test_a_float_cannot_sneak_into_a_fixed_order_preimage
```

Diagnosed far enough to be actionable: the pinned value **matches the
TypeScript**, so it is the Python that has drifted —

```
node (the shipped formula) : 01b1a7a6f7344a8aac3ea6723e0aa8118c3d90da7422f07054284f65a2852b8c
pinned in the test         : 01b1a7a6f7344a8aac3ea6723e0aa8118c3d90da7422f07054284f65a2852b8c
scruple_host_sdk           : 9cac7c396344e5417aea5f2b204c1f4a1d903950e2cdae4c614038aed6fd44b9
```

It is the same failure class as this WO's — one written rule, two languages,
different bytes — in a different preimage (`input_hash`, not the Merkle root).
Fixing it changes a shipped preimage, which is a decision rather than a cleanup,
so it is reported rather than quietly repaired. **Left red, deliberately and
visibly.**

## 11 · Suites

`06-suites-after.txt`:

| suite | before | after |
|---|---|---|
| `npm run test:v2` | 808 pass / 0 fail | **818 pass / 0 fail** (34 files; +10 from this WO) |
| `npm run test:conformance` | — | 47 pass / 0 fail |
| `npm run test:integration` | — | 19 pass / 0 fail |
| `npm run test:sdk` | 2 fail | 2 fail — **pre-existing at `HEAD`**, §10(b) |
| `npm run merkle:conformance` | did not exist | exit 0, all controls land, no implementation passes |

`test/v2/canvas-retrofit.test.ts`'s tamper-surface pin was re-recorded: two npm
scripts and the glob fix moved `package.json`, which is TRACKED for its
dependency pins and hashed whole. The reason is written into
`lib/canvas/baseline.ts` beside the constant, as WO-C3 did, rather than left as
a bare new hash. Nothing canvas captures changed and no dependency pin moved.
