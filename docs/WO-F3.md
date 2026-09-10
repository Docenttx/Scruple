# WO-F3 — the standalone add-on declares what it did not observe

_2026-09-10. `docs/STATE.md` §4.7 / `docs/WO-E7.md` finding **E7-1** — the
finding the E series ends on._

**Gate: PASS.** 82 checks, 0 failures, 0 inconclusive — `npm run f3`,
transcript `.run/f3-gate-4.txt`. Six real Blender 4.2.23 runs, two of them at
the add-on's parent commit to show the finding red first.

Changed: `/data/scruple-web` `5aeece5` (the leaf, the route, the SDK),
`/data/scruple-blender` `d98bf8b` (the enumerator). The desktop repo carries the
gate, the two probes, this report, and the one E7 assertion that had to be
flipped because it asserted the silence.

**The one-line result.** Two Blender scenes built around two different AI
images: **before**, the two leaves were identical in every field capable of
saying so, and `input_hash` was NULL on both. **After**, each leaf names the
datablock that came in, carries a digest that re-hashes from the bytes on disk
with `sha256sum`, and says — as a value, not as an absence — that **nobody here
watched it arrive**.

---

## What this does NOT do

Said first, because it is the part most easily overread.

**It does not tell anyone what model made the image.** Nothing in this path
knows that. A leaf that implied it would be the *false* claim E7-1 was careful
to say this defect is not.

**It does not give the add-on byte coverage of the AI step.** `host_semantics`
is still NULL on an add-on leaf, `model_fingerprints_hash` is still NULL, and
the gate asserts both so they stay visible. This product still has no gate in
it.

**It does not make the absence set a closure over everything foreign.** It is a
closure over the datablock tables it enumerated — images — and the document
says so in `datablock_types`.

What it does is say: **these datablocks entered this document from outside it,
here are the digests of their bytes, and the party that produced this leaf did
not observe how they came to exist.**

## The decision, and why the other two were refused

The work order took this and the reasons are the substance:

- **NOT `host_semantics: blind`.** In `docs/HOST-HOOK.md` and migration 058,
  `blind` means *full byte coverage and no meaning* — a gate saw every byte and
  could not read them. The standalone add-on has **no byte coverage of the AI
  step at all**. `blind` on that leaf would assert a capture path that does not
  exist, which is worse than the silence it replaces.
- **NOT `declared_uncaptured`.** WO-E2's absence set is a closure over what an
  upstream **reported** through `/history`. There is no upstream here and
  nothing reported anything, so the set would carry no scope and E2's own rules
  would make it read `not_enumerated` forever.
- **YES to naming the datablocks**, because Blender *knows*: an image packed
  into a `.blend` has a datablock, a source path, and bytes that can be hashed.

## The shape it took

**Five signed scalars and one document**, which is 058's and 059's split. The
document is a member list and cannot ride in a MAC preimage, so only its
**digest** is signed; the route recomputes the digest from the document and
refuses every pair that disagrees.

| field | 0 / `false` means | NULL means |
|---|---|---|
| `imported_datablocks_source` | `host_datablocks`: the host's own table was enumerated. `none`: nothing enumerated anything | the question was never asked of this leaf |
| `imported_origin_observed` | **nobody here watched these bytes arrive** | — |
| `imported_datablocks_count` | **enumerated, and none came from outside** | nothing enumerated |
| `imported_datablocks_unreadable_count` | every member had readable bytes | — |
| `imported_datablocks_hash` | the digest of the document | — |

### ⚑ The scalars are SUBMISSION fields, not `capture` fields

This is the design decision inside the design decision, and it is asserted by a
test rather than left in prose.

`capture` is what a capture **component** observed, and
`lib/leaf/captureClaims.ts` rightly obliges any capture-bearing leaf to declare
an attestation basis, a profile, a storage confinement, an upstream epoch and a
host level. **The product this field exists for has none of those**: the
standalone add-on is a plugin, there is no component, `component_verified` is 0
on every leaf it writes. Putting the declaration inside `capture` would have
obliged it to invent five observations it cannot make in order to say one true
thing about an imported image.

So the scalars sit at the submission root beside `machine_manifest_hash`, and
`componentPreimage()` reads them from there — inside the MAC just the same. The
two mirror-image mistakes are both refused with a named code: a scalar sent
**down** into `capture` (where the preimage does not read it) and the document
sent down there too (where nothing would hash it).

### ⚑ And how a plugin's declaration is bound to its leaf at all

The five scalars are in the ratchet MAC, which covers them for any submission
carrying a component envelope — and **this product carries none**. A MAC nobody
computed binds nothing.

What binds it is the **leaf**. The declaration's digest is folded into the run's
input manifest as one ref under a reserved kind, so it enters `input_hash` —
and the witness hashes `input_hash` into the `v2.2` canonical record whose
sha256 **is the leaf hash it signs**. One flipped hex digit in one datablock's
digest therefore moves the leaf hash. Control (c) below measures all of it,
from the witness's own database, in Python.

🔴 The alternative was a new field in the witness's record, and it is refused
twice over: the witness process is out of bounds for this series, and a new
record field would be a new leaf scheme that no existing leaf could express.
`input_hash` already means "what went into this run", and an imported datablock
is exactly that — E7-1 measured it NULL on both add-on leaves, which is the
same silence one column over.

## The gate, and the four controls

`npm run f3` — `scripts/f3-gate.sh`, transcript `.run/f3-gate-3.txt`. Six real
Blender 4.2.23 runs, the shipped zip installed through the **manifest** path
(the one every 4.2+ user gets), the add-on configured through its **preferences
fields** — so WO-F1's fix is re-exercised on the way — and every capture taken
by the add-on's own `save_post` handler. Nothing in the harness calls a
`witness_*` function.

⚑ **The two AI images are outputs of two ComfyUI generations Desktop Studio
witnessed in WO-E7's run**, days earlier, in a different product, with no
identifier shared with anything in this gate. That is what makes control (d) a
composition rather than a coincidence.

### ⚑ STAGE 1 — the red before, which is E7-1 reproduced rather than quoted

The add-on's **parent commit** is checked out into a worktree, built into a
zip, installed through the manifest path, and run on the same two scenes. Its
leaves:

```
   b1 = leaf 955 (image A)                  b2 = leaf 956 (image B)

   imported_datablocks_source        (NULL) on both      ← nothing declared
   imported_datablocks_count         (NULL) on both      ← "found none" unreadable
   imported_origin_observed          (NULL) on both      ← nobody asked
   imported_datablocks_hash          (NULL) on both
   input_hash                        (NULL) on both      ← nothing folded
   workflow_hash                     IDENTICAL
   machine_manifest_hash             IDENTICAL
   model_fingerprints_hash           (NULL) on both
   host_semantics                    (NULL) on both
   output_hash                       89c1df81… / 70cc50f6…   ← only this moved
```

E7-1, live, against today's server: **every field capable of describing how the
artifact came to exist is invariant under the AI step, and only the digest of
the document's own bytes moves.**

⚑ **The first run of this gate could not make that measurement, and the harness
was what was wrong.** It gave each run its own scene name, its own work
directory and the imported file's own name — and `build_save_workflow` puts the
scene name and the absolute path in the workflow, while `machine_manifest_hash`
folds the *unredacted* workflow. So `workflow_hash` and `machine_manifest_hash`
moved for reasons that had nothing to do with the image, and the gate scored two
FAILs *asserting the finding*. One scene name, one directory, one imported
filename, image copied over it: what differs between two runs is now the bytes
and nothing else. Recorded because a harness that varies three things at once
cannot measure one of them, and the transcript looked like a defect in the
product.

### ⚑ STAGE 2 — the gate

Two leaves, two different imported images:

- the declaration **differs** — and the two documents differ **only** in
  `digest` and `bytes`: same datablock name, same basename, same count, same
  scope;
- each declared digest **is `sha256sum` of the imported file**, recomputed in
  the shell outside every process under test;
- the stored document **re-hashes to the stored digest** (the column holds the
  canonical bytes that were hashed, not a re-serialisation);
- the datablock is **named**, the scope it ranged over travels with it
  (`["image"]`), the filename is a **basename**, and `digest_of` says **which**
  bytes were hashed (`packed_bytes`);
- and `imported_origin_observed` is **0** — a value, not an absence.

Asserted in the same stage so they stay visible: `host_semantics` is **still
NULL**, `model_fingerprints_hash` is **still NULL**, and `workflow_hash` is
**still invariant** under the AI step. F3 closes one of E7-1's two halves.

### CONTROL (a) — the empty declaration is PRESENT

A scene with nothing imported: `source: host_datablocks`, **count 0**, the
document stored with `datablocks: []`, and the origin question answered. It is
distinguishable from the parent commit's silence on the leaf itself — 0 against
NULL — and, because the fold happens whenever there is a document, on
`input_hash` too: present against absent.

⚑ **ANTI-VACUITY, and it is the control that matters here.** `Render Result` and
`Viewer Node` are image datablocks in every real Blender from startup, and the
gate asserts the file **does** hold two of them while the declaration counts
**zero** imports. A filter that counted datablocks rather than reading
`Image.source` would have made this control pass by accident.

### CONTROL (b) — unreadable is recorded, not omitted

One packed image and one linked image whose file is deleted after loading:
count **2**, unreadable count **1**, and the missing one is a **member** whose
`unreadable` reads `source_file_missing` and whose `digest` is null — not
omitted, and not given the other file's digest. The readable one keeps its own.
WO-D3's rule: the refusal keeps the member and refuses only the claim, and the
byte count survives it.

### CONTROL (c) — in the MAC, and it moves the leaf hash

Four measurements, and the middle two are the ones that matter for a product
with no component:

1. all **five** scalars are keys of `componentPreimage()`, a changed digest
   changes the preimage, and the **document is not in it** — read out of the
   server's own function from the shell;
2. `input_hash` on the add-on's leaf **is** the fold of the declaration's
   digest — recomputed by `scripts/f3-leaf-arithmetic.py` with the SDK's own
   **Python** canonicalizer, a different implementation in a different language
   from the TypeScript that wrote it;
3. the witness's own sqlite row for that leaf is a `v2.2` record, and
   recomputing that record's canonical form **reproduces the leaf hash the
   witness signed**;
4. so flipping **one hex digit** of the declaration's digest moves `input_hash`
   and therefore moves that leaf hash — carried all the way through and printed.

Plus the live refusals, over `curl`, against the running app: a digest that does
not match its document, a digest with no document, a document with no digest, an
enumerated source with no count (which names the *required* code, not the
*refused* one), a precomputed `input_hash` beside a declaration, a caller forging
the reserved input kind — and ⚑ **a leaf claiming it watched the import**, which
is refused with the blocker named rather than downgraded.

⚑ **The control for the controls:** a submission that declares **nothing** is
still accepted and reads NULL. Otherwise this field would be a new requirement
on every existing caller.

**Red for (c):** the parent commit's leaves folded nothing — `input_hash` NULL
on both — which is the same leaf-level silence whichever image was inside.

### CONTROL (d) — the two products link by digest

Desktop Studio's leaf `748` witnessed `ac742619…` on 2026-09-09; the add-on's
leaf `957` declared the same digest on 2026-09-10. The join runs over the stored
document, given only a content hash, with **no identifier shared between the two
leaves except the digest of the bytes** — and the control fires correctly: the
leaf built around the *other* image does not join.

⚑ **Neither leaf overclaims.** The add-on's still says nobody there watched the
import arrive. The link is something a **third party computes from two
records**, not something either record asserts. That is the whole composition
argument in the work order, and it now has an observable.

## Findings

### ⚑ F3-1 — the SDK's three leaf-hash formulas were on the WRONG canonicalizer

Found on the way, in the one formula this work order folds a digest through.

`packages/scruple-api/scruple_api/model_write.py` imported `canonicalize`
**twice**:

```py
from .canonical import canonicalize                      # the jcs-2, RFC 8785 one
from typing import ...
from .manifest import canonicalize, sha256_file, sha256_hex   # <- shadows it
```

so `hash_training_recipe`, `hash_run_inputs` and `hash_model_fingerprints` — the
Python side of `workflow_hash`, `input_hash` and `model_fingerprints_hash` — all
ran on `manifest.canonicalize`, which is the pre-WO-21 sorted-keys
`json.dumps`: `ensure_ascii=True`, Python `repr` for floats, and
`NaN`/`Infinity` **emitted rather than refused**. Measured against the server,
which computes the same three digests with RFC 8785:

```
   {"filename": "café.png", "x": 1e-5}
     jcs-2 (the server, and TypeScript)   {"filename":"café.png","x":0.00001}
     manifest.canonicalize (this side)    {"filename":"café.png","x":1e-05}
```

They agree on ASCII strings and small integers — which is every value the tests
happened to use — and diverge on **a non-ASCII filename or a float**, where a
verifier recomputing the digest in the other language gets a mismatch that is
indistinguishable from tampering. That is verbatim the defect WO-21 fixed on the
TypeScript side, and the comment inside `hash_model_fingerprints` already
believed it had been fixed here.

**It matters to this work order specifically.** A declared datablock's
`filename` is a user's filename, and users have non-ASCII filenames. The
declaration's own digest is computed through `scruple_api.canonical` explicitly
(`imported_datablocks.document_hash`), so F3's field was never on the wrong
formula — but `input_hash`, which now carries that digest into the leaf, was.

**Fixed here**, one import removed, with the argument in the file.
`manifest.canonicalize` is not wrong and is not removed: it is the `jcs-1`
formula and `hash_*_legacy` still replays rows written under that profile
through it. What was wrong was reaching it by accident.

**And it had been red the whole time.** Two SDK tests pinned the pre-jcs-2
values — `test_the_dataset_lands_on_input_hash_with_the_shipped_formula` and
`test_a_float_cannot_sneak_into_a_fixed_order_preimage` — so `npm run test:sdk`
was **3 failed, 213 passed at HEAD** before this work order and nothing was
watching. They are re-pinned against the TypeScript, which is what they exist
for, and the float one now asserts the **agreement** rather than a refusal that
RFC 8785 §3.2.2.3 makes wrong. 216 pass.

### F3-2 — the add-on's leaf still carries a baseline that describes other bytes

Not new — it is WO-F1's finding **F1-2** — but it applies to this change and is
worth recording once more. This work order moves the add-on's tamper surface
(`6c4f2c03df2d…` for the installed tree in this gate), and the leaves still
carry `baseline_hash = 22e97c93c1d8…`, because `attach()` **adopts the server's
active baseline** for the tenant whatever the local surface hashes to, logs
`baseline drift`, and carries on witnessing. So an add-on leaf's `baseline_hash`
answers *"what did this tenant last register"*, not *"what code produced this"*.
`docs/WO-F1.md` finding F1-2 owns it.

### F3-3 — the join is a scan, and nothing indexes it

Control (d)'s query is `imported_datablocks LIKE '%' || :hash || '%'` over the
stored document. That is a table scan over every leaf that declared anything,
and migration 060's index on `imported_datablocks_count` only narrows the
candidate set. For a sandbox with a thousand leaves that is free; for an estate
it is the kind of query an auditor stops running.

The right shape is a join table — one row per declared datablock, `(leaf_id,
digest)` — populated at ingest. It is **not built here**: it is a second schema
object with its own backfill and its own consistency question against the
document, and this work order's job was to make the fact expressible. Named so
the next person does not discover it under load.

## What is still missing after this

- **`host_semantics` is still NULL on an add-on leaf.** That is E7-1's other
  half and it is deliberately not touched: `blind` would assert byte coverage
  this product does not have, and the work order says so. What would close it is
  a fourth `host_semantics` value meaning *"this leaf came through a door with
  no capture path at all"* — a vocabulary change to migration 058 that every
  reader of that column would have to learn. **Needs a decision.**
- **`workflow_hash` is still unreadable at the column level.** E7-1's second
  paragraph: the route hashes `graph` and discards it, so a ComfyUI generation
  graph and a Blender render-settings dict read identically. Untouched here.
- **Only images are enumerated.** Libraries, sounds, fonts, movie clips and text
  blocks can all hold something foreign. The document declares its scope, so
  adding a table later is a wider claim that says so rather than a silent change
  of meaning — but today the claim is narrow.
- **The declaration is enumerated at witness time**, so a datablock added
  between the render and the save appears on the second leaf and not the first.
  That is the honest reading — each leaf declares the document as it was when
  that capture was taken — but it means two leaves from one session can
  legitimately disagree.
- **The bound is 64 MiB** (`IMPORTED_DIGEST_LIMIT_BYTES`). A 2 GB texture is a
  member with `unreadable: over_digest_limit` and its byte count, not a hang on
  a user's save. Nobody has measured what that limit costs on a real project.
- **These leaves are still unsigned by H-1 and still read `stale`.** §4.1 and
  §4.2 — the scratch witness runs with signing disabled and the estate's three
  Merkle constructions disagree. The declaration is bound to the leaf hash; what
  the leaf hash is *worth* to a third party is those two open items, not this
  one.

## Files

| repo | file | what |
|---|---|---|
| `scruple-web` | `lib/db/migrations/060_imported_datablocks.sql` | five scalars, a document, and the cross-column CHECKs 059 uses |
| `scruple-web` | `lib/capture/importedDatablocks.ts` | the vocabulary, the validator, the named origin-observer blocker, the reserved input kind |
| `scruple-web` | `app/api/v2/witness/route.ts` | accept, recompute, refuse, **fold into `input_hash`**, store, echo |
| `scruple-web` | `lib/leaf/componentPreimage.ts` · `services/scruple-capture/src/leaf.ts` · `server_library.py` | the same five keys in all three implementations, in lockstep |
| `scruple-web` | `test/vectors/component-preimage-vectors.json` | a fourth case, pinning the field set across the three |
| `scruple-web` | `packages/scruple-host-sdk/.../imported_datablocks.py` | the document's shape, the digest, the scalars derived from it, and the two digest helpers |
| `scruple-web` | `packages/scruple-api/.../model_write.py` | finding F3-1 — one import removed |
| `scruple-web` | `test/v2/imported-datablocks.test.ts` | 33 checks, every control named |
| `scruple-blender` | `adapter/scene.py` | `imported_datablocks()` — the enumerator, filtering on `Image.source` |
| `scruple-blender` | `adapter/flow.py` | the declaration on every capture, `origin_observed=False` at the call site |
| `scruple-blender` | `tests/test_imported_datablocks.py` | 15 checks, with the render-result anti-vacuity control |
| `scruple-desktop` | `scripts/f3-gate.sh` | the gate |
| `scruple-desktop` | `scripts/f3-addon-alone.py` | the add-on alone, with imports, without them, and with one it cannot read |
| `scruple-desktop` | `scripts/f3-datablock-probe.py` | ⚑ the measurement the design rests on: packed bytes ARE the file's bytes |
| `scruple-desktop` | `scripts/f3-leaf-arithmetic.py` | the fold and the witness's `v2.2` record, recomputed outside the server |
| `scruple-desktop` | `scripts/e7-gate.sh` | `input_hash` moved out of the invariance loop — it is now the column that must MOVE |

## The probe the whole design rests on

`scripts/f3-datablock-probe.py`, inside real Blender 4.2.23:

```
   sha256 of the file on disk        ac742619209655c8…
   sha256 of packed_file.data        ac742619209655c8…   matches: true
   sha256 via bpy.path.abspath       ac742619209655c8…   matches: true
   a deleted source                  packed_file: null, has_data: false, FileNotFoundError
   an image made in memory           source: GENERATED, filepath: ""
   after a render                    bpy.data.images unchanged
```

`pack()` stores the file **verbatim**. That is the single fact control (d)
depends on: if Blender re-encoded on pack, the digest would describe bytes
nobody else ever held, and the composition claim would be false while looking
perfectly fine. It is measured rather than assumed, and the bpy mock's docstring
records the result so a unit test cannot quietly contradict it.

## Rails

Sandbox only: app `:3902`, witness `:5899`. The witness's sqlite is opened
**read-only** to recompute a leaf hash; `/opt/scruple-witness` is untouched and
the witness's own record format was **transcribed, not changed** — a new field
in the leaf was the alternative and it is refused in the route's own comment.
Nothing contacted `:5799` or `:3001`. `CHECKPOINT_VECTORS_SETTLED` untouched;
every leaf here reads `stale` and `component_verified = 0`, which is correct for
this product. `$HOME` redirected per Blender run. `docs/README-TRAVEL-LAPTOP.md`
and `docs/WO-W1.md` untouched, no shared history rewritten.

## The transcript, in one table

`.run/f3-gate-4.txt`, the leaves this run wrote:

| leaf | run | source | count | unreadable | origin observed | declaration | input_hash |
|---|---|---|---|---|---|---|---|
| 955 | parent commit, image A | NULL | NULL | NULL | NULL | NULL | NULL |
| 956 | parent commit, image B | NULL | NULL | NULL | NULL | NULL | NULL |
| 957 | shipped, image A | `host_datablocks` | 1 | 0 | 0 | `b5836dc5c4c7…` | `4e2e54dc5230…` |
| 958 | shipped, image B | `host_datablocks` | 1 | 0 | 0 | `4bee8cfebf57…` | `6aaa072a107c…` |
| 959 | shipped, **no imports** | `host_datablocks` | **0** | 0 | 0 | `95befe8b6183…` | `64057215e52d…` |
| 960 | shipped, one **unreadable** | `host_datablocks` | 2 | **1** | 0 | `b96d85a4889e…` | `9eeecd10354b…` |

The first two rows are the finding. The rest is what a leaf can say now.

## ⚑ What was NOT re-run, and what stands behind the flip instead

`scripts/e7-gate.sh` had `input_hash` inside its invariance loop — the loop that
asserts *every field capable of describing how the artifact came to exist is
identical for two different AI images*. That assertion is now **wrong on
purpose**, and leaving it would have made the estate's own suite require the
silence to stay: exactly the mistake WO-F1 and WO-F2 each flipped in their own
stages. `input_hash` is moved out and asserted to **move**, beside
`imported_datablocks_hash` and `imported_origin_observed`.

**The E7 gate was not re-run end to end.** It needs two ComfyUI generations and
two Cycles renders under `qemu`, which is a one-to-two hour job, and this work
order's budget went on six Blender runs of its own. So the flipped assertions
are proved by `npm run f3` on the same product and the same add-on build — on
its **`save_post`** leaf rather than its **`render_write`** one. That is a real
difference and it is stated rather than glossed: the declaration is enumerated
from `bpy.data` at witness time and does not depend on which handler fired, but
nobody has watched those three checks go green inside the E7 gate itself.
**Whoever runs `npm run e7` next is the first to see it.**

## Also in this commit: WO-F2's desktop artifacts

The previous session committed WO-F2 in `/data/scruple-blender` (`8c9062a`) and
left the desktop side **uncommitted** in the working tree — `docs/WO-F2.md`,
`scripts/f2-gate.sh`, the two F2 probes, `scripts/e7-worker-stop-probe.py`
flipped to assert the fix, the `f2` script entry, and `docs/STATE.md` §4.9's
closure. Those are carried in this commit rather than dropped or rewritten;
they are WO-F2's work and its report is its own file. Splitting them out would
have meant hunk surgery on three files two work orders both touched, which is a
worse trade than saying so here.
