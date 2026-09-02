# The watermarked derivative in the chain — verifier procedure

**Scope:** how a watermarked derivative enters a Scruple project's Merkle
tree, and what a verifier has to do that it did not have to do before.
Landed by WO-28. Companion to `docs/architecture/WATERMARK_DESIGN_v1.md`
(the mark itself) and `lib/leaf/registry.yaml` (the field registry).

---

## 1. What changed, and why it had to

Before WO-28, `POST /api/lock/local` ran in this order:

```
buildMerkle(master leaf hashes)  →  witness finalize  →  watermark
```

`finalize` inserts a `locked_projects` row on the witness server, and
`handleWitness` **403s any witness request for a project holding one**.
So the derivative was not merely produced after the seal — **it could not
be witnessed at all.** `iterations.watermark_derivative_leaf_hash`, added
by migration 038 in July, had been NULL since the day it landed for that
structural reason.

The order is now:

```
watermark  →  witness each derivative  →  buildMerkle(masters ++ derivatives)  →  finalize
```

**The 403 was not widened.** It is the only thing stopping a sealed
project from growing a leaf afterwards, and a derivative is precisely the
leaf someone would want to add afterwards. The fix is to stop being late.
`test/v2/watermark-chain.test.ts` asserts the guard still refuses a
well-formed derivative on a locked project, and separately reproduces the
July NULL by deliberately running the watermarker after the seal.

---

## 2. Sibling, not ingredient-of-the-master

A derivative gets **its own leaf**. The master's leaf is never rewritten.

The master leaf was sealed at generation time, over a record whose
`server_timestamp` names that instant and whose `prev_record_hash` binds
it into the witness's own chain. Folding the derivative into that
preimage would mean recomputing and re-signing a record claiming a moment
at which the derivative did not exist. That is not a stronger commitment;
it is a manufactured one — and it is the same append-only violation the
403 exists to refuse, committed from inside.

C2PA points the same direction: a derived asset carries its own manifest
naming the master as a `c2pa.ingredient`, and the master's manifest is
untouched.

So: **sibling in the tree, ingredient in the record.** The lineage
pointer lives inside the derivative's preimage and points backwards.

---

## 3. The derivative leaf — scheme `v2.5`

`services/witness-server/server.js`, `canonicalRecordV25`. Field order is
the protocol; it is also declared in `lib/leaf/registry.yaml` under
`leaf_schemes: v2.5`, and `test/v2/watermark-chain.test.ts` fails if the
two drift.

```
sha256(JSON.stringify({
  run_sequence:                <synthetic, see §4>,
  output_hash:                 <sha256 of the DERIVATIVE bytes>,
  input_hash:                  "",
  workflow_hash:               "",
  model_fingerprints_hash:     "",
  machine_manifest_hash:       "",
  master_hash:                 <sha256 of the CLEAN MASTER bytes>,
  watermark_payload_hex:       <32 hex, magic 0x5c, version nibble 1>,
  ingredient_master_leaf_hash: <the MASTER's own leaf_hash>,
  server_timestamp:            <witness server's stamp>,
  prev_record_hash:            <chained from the project's prior leaf>,
}))
```

`master_hash`, `watermark_payload_hex` and `ingredient_master_leaf_hash`
are **all three or none**: the server answers a partial set with a 400
(`invalid_master_hash` / `invalid_watermark_payload` /
`invalid_ingredient_leaf_hash`) rather than falling back to `v2.2`. A
lineage claim with a hole in it is worse than no claim.

The vocabulary and its validation are a **port**, not a new design —
`lib/witness/ingest.ts:45-51` and `219-244` have carried the same three
fields and the same rules since July on the `/v1/log` surface, which is
the surface the lock does not use. That mismatch is why the column stayed
NULL.

**Why `v2.5` and not `v2.3`.** `v2.3` already names a completely
different preimage on the Continuous Audit API's ladder
(`lib/witness/canonicalLeafV23.ts`), and one name meaning two preimages
on two surfaces is the exact confusion being closed here. `v2.4` is
already the `introduced_in` tag of the H-1 signature fields in the
registry. `v2.5` is the next free number.

---

## 4. Leaf order in the tree

```
leaves = [ every master leaf, run_sequence ASC ]
      ++ [ every witnessed derivative leaf, its master's run_sequence ASC ]
```

Defined once, in `lockLeafOrder()` (`lib/watermark/apply.ts`).

Appending rather than interleaving buys two properties:

* a project with **no** derivative produces a **byte-identical** root to
  the one it produced before WO-28;
* master leaf index still equals `run_sequence − 1`, the invariant
  `app/api/verify/route.ts` checks.

The synthetic `run_sequence` a derivative is witnessed under is
`max(master run_sequence) + master run_sequence` — strictly greater than
every master, distinct per master, monotone in the master's order, so the
witness server's own `prev_record_hash` chain also puts every derivative
after every master.

---

## 5. What a verifier must now do differently

1. **Stop assuming leaf count equals iteration count.** The lock response
   now returns `masterLeafCount` and `derivativeLeafCount` alongside
   `leafCount`. `leafCount = masters + derivatives`.

2. **Rebuild the leaf list with the §4 concatenation**, not
   `iterations.map(leaf_hash)`.

3. **Recompute each derivative leaf** with the §3 preimage. Every field
   is stored on the `iterations` row (migration 048) so the leaf is
   reproducible from the row alone:
   `watermark_derivative_run_sequence`, `watermark_derivative_hash`,
   `output_hash`, `watermark_payload_hex`, `leaf_hash`,
   `watermark_derivative_witness_timestamp`,
   `watermark_derivative_prev_record_hash`. The witness server's
   `GET /api/witness/:projectId` now returns the same fields, so the
   check can be run against the witness rather than against us.

4. **Check the lineage edge.** A derivative leaf's
   `ingredient_master_leaf_hash` MUST be a leaf of the same tree. A
   derivative naming a master outside the tree is not evidence about this
   project.

5. **Check the mark against the record.** Decode the watermark from the
   derivative bytes and confirm the recovered payload equals
   `watermark_payload_hex` in the leaf. The leaf commits to *what the
   mark says*, not merely that a mark exists.

6. **Do not expect the master to mention the derivative.** The edge is
   one-directional by design (§2).

### Known limitation — lock-package manifest v1

`LockPackageManifest` (`lib/types.ts`) has an `iterations[]` array and no
derivative fields, and `app/api/verify/route.ts` recomputes the root from
`iterations[].leafHash` alone. **For a locked project that carries a
witnessed derivative, that recomputation is short by the derivative
leaves and will report a root mismatch.** This is not a defect introduced
by the reorder — any design that commits to the derivative changes the
root, and manifest v1 has no way to express it.

Closing it is a **manifest v2**: add a `derivatives[]` array carrying the
§3 preimage fields per derivative, have `buildLockPackage` populate it,
and have `verifyManifest` rebuild the leaf list with §4. Owned by whoever
takes the manifest, not by WO-28 —
`lib/scruple/lock-package.ts`, `lib/types.ts` and
`app/api/verify/route.ts` are outside its file set.

---

## 6. Tiers 4 and 5 cannot use this shape as written

The tier-3 payload carries no SCR-ID, so deriving the SCR-ID from the
full root is not circular.

Tiers 4 and 5 embed the SCR-ID **in the payload**, and the payload is in
the derivative's preimage, which is in the root, from which the SCR-ID is
derived. That is a cycle. They need a two-phase design: SCR-ID from the
master-only root, derivative leaves extending the tree afterwards, and a
receipt that says plainly that the SCR-ID commits to the masters while
the final root commits to both.

Neither `app/api/lock/chain/route.ts` nor
`app/api/lock/checkpoint/route.ts` calls the watermarker today. This is
written down so whoever wires them does not discover it at runtime.

---

## 7. Seam: C2PA

The artifact that should be C2PA-signed is the **derivative** — it is the
file the public receives. Today `/api/scruple/c2pa/sign` signs an
arbitrary asset with `intent: CREATE` and no ingredient, and nothing in
the repo calls it.

The signing call belongs in `lib/watermark/apply.ts`, immediately after
the derivative leaf is minted: `signAsset` with intent EDIT, a
`c2pa.edited` action, and the master as a `c2pa.ingredient`, binding
`watermark_derivative_leaf_hash` into the manifest. Deliberately not
implemented by WO-28 — another work order owns signing, and a second
signer is the last thing this estate needs.

`iterations.watermark_signed_at` is the timestamp of the **watermark**
event, not of a signature. Do not repurpose it.

---

## 8. Deployment

`services/witness-server/server.js` in the repo and
`/opt/scruple-witness/server.js` in production were byte-identical before
WO-28. **They are not any more.** The derivative path needs the deployed
witness to carry `canonicalRecordV25`, the three `witnesses` columns, and
the validation — until it does, `lib/watermark/apply.ts` sees a `v2` leaf
where it expects `v2.5`, records the derivative in `unwitnessed` with
that reason, and leaves `watermark_derivative_leaf_hash` NULL. The lock
still succeeds; the derivative simply stays out of the chain, visibly,
exactly as it did before.

That check is deliberate: recording a `v2` leaf for a derivative would
look witnessed and prove nothing.
