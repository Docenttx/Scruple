# WO-E7 — the two products, mirrored, and an honest close-out

_2026-09-09. Desktop repo only: `/data/scruple-web` and `/data/scruple-blender`
are **untouched**, and `app/` is byte-identical to WO-E6's commit — this work
order adds no application code at all. Gate: `bash scripts/e7-gate.sh`
(`npm run e7`). The three-way comparison on its own is
`python3 scripts/e7-leaf-diff.py --a <leaf> --b <leaf> --c <leaf>`._

---

## ⚑ THE MOST IMPORTANT FINDING IN THE SERIES, FIRST

The work order says: *"Row 1 is the one to get right: the addon alone must not
imply anything about an AI step it never observed. If it currently does, that is
the most important finding in this series and it goes at the top of the report."*

**It does not imply anything. It says nothing at all, and saying nothing is not
the same as being honest.**

`docs/BLENDER.md` states the intent in one sentence: *"Something was imported
here and we do not know what it was" is the true statement, and it needs to be
on the leaf, not in a footnote.* Measured today: **it is not on the leaf.**

### How it was measured

One Blender scene, built around an image that came out of a ComfyUI generation
the add-on never saw — packed into the `.blend`, emitted through a shader onto a
plane, and rendered by Cycles so that the artifact's pixels **are** the AI
output. The add-on's own ambient handlers did the capturing; nothing in the
script calls `witness_*`. Then the whole thing again with a **different** AI
image, in a scene with the same name, the same camera, the same frame and the
same filenames.

Two artifacts made from two different AI outputs. Two leaves:

```
   output_hash             d0bd7956a980b654…  vs  762cf546316fd80d…    MOVED
   workflow_hash           52be7d74589059b4…  ==  52be7d74589059b4…    same
   machine_manifest_hash   645dada745696e36…  ==  645dada745696e36…    same
   model_fingerprints      NULL               ==  NULL
   model_fingerprints_hash NULL               ==  NULL
   input_hash              NULL               ==  NULL
   input_artifacts         []                 ==  []
   host                    NULL               ==  NULL
   host_semantics          NULL               ==  NULL     ⚑ not `blind`. NULL.
   host_evidence           NULL               ==  NULL
   leaf_scheme             v2.2               ==  v2.2
   canonicalization_profile jcs-2             ==  jcs-2
   leaf_kind               workflow           ==  workflow
```

**Every field that could describe how the artifact came to exist is invariant
under the AI step.** Only the digest of the bytes moves, and it moves because
they are different bytes.

And the graph itself, rebuilt outside Blender from the add-on's **own**
`build_render_workflow`, its **own** `graph_for_wire` redaction and its **own**
vendored `scruple_api.canonical.hash_workflow` — and proved to be that graph
because its digest is the `workflow_hash` on the leaf:

```json
{"camera":"CAM_hero","engine":"CYCLES","filename":"e7-render.png","frame":173,
 "kind":"blender_render","resolution":[64,64],"samples":1,
 "scene":"atrium-f76e18ba219036c1","trigger":"render_write"}
```

Nine keys. None of them is about the image that was imported. The gate asks that
question of the document with a deliberately generous needle set — the
datablock's name, its path on disk, and the words `imported`, `image`,
`texture`, `ai` — and gets **0**.

### The two separate problems inside that

**1. `host_semantics` is NULL, not `blind`.** `HOST-HOOK.md`'s central claim is
*"a Level-1 leaf DECLARES its blindness. It is not a Level-2 leaf minus some
fields."* That claim does not reach this product. Migration 058's own comment
draws the line: NULL means *"the question was never asked of this leaf"* and
`blind` means *"there was a hook and nobody was registered on it"*. `buildLeaf`
defaults to `blind` for a **component**; the add-on is a plugin, has no capture
block, and its whole capture block — twenty-four columns of it — is NULL. The
same NULL a leaf written before the hook existed reads.

So the record cannot distinguish:

| the truth | what the leaf says |
|---|---|
| this render is of geometry somebody modelled | `host_semantics` NULL |
| this render is of an AI image somebody imported | `host_semantics` NULL |
| this leaf predates the host hook entirely | `host_semantics` NULL |

**2. `workflow_hash` is non-null and unreadable.** The v2 witness route hashes
`graph` and **discards it** (`lib/leaf/hashes.ts`; the column is
`workflow_hash`, and there is no `workflow` column). So the field that says
"there was a graph" reads identically for a ComfyUI generation graph and a
Blender render-settings dict:

| | add-on alone | Desktop Studio alone | both |
|---|---|---|---|
| `leaf_kind` | `workflow` | `workflow` | `workflow` |
| `workflow_hash` | `52be7d745890…` | `e24bfd0ea578…` | `f6597e5aff6c…` |
| `canonicalization_profile` | `jcs-2` | `jcs-2` | `jcs-2` |

`docs/BLENDER.md`'s table says the add-on-only row has **no graph**. At the
column level that is **wrong**, and the gate asserts the measurement rather than
the prediction — the E6-5 rule, applied to this work order's own source
document. What the table means is "no *ComfyUI* graph", and nothing on the leaf
records which kind it is.

### What it is, and what it is not

⚑ It is **not a false claim**. Nothing on an add-on-only leaf asserts anything
about an AI step, and no verifier reading it carefully is misled about what was
witnessed: these bytes existed, they were this size, this is their digest, and a
build with this baseline said so at this time. That is all true.

It is an **absent** claim, and absence reads the same as "there was nothing" —
which is precisely the failure mode `blind` / `declined` exists to prevent one
layer down. The distinction `HOST-HOOK.md` fought for between "an integration
that was never done" and "an integration that is not working" has no member for
"a product with no gate in it at all", and that is the product `docs/BLENDER.md`
row 1 describes.

### What would fix it — three options, none of them the add-on's to take

Every one of these changes the **server's** leaf, so none belongs in the add-on
repo alone.

1. **Let the plugin door carry a capture block.** The add-on submits
   `capture: { host_semantics: "blind", … }` and `captureClaims.ts` rule 7
   accepts it. Cheapest, and it makes the plugin's blindness *declared* the same
   way a component's is. ⚑ But rule 7 also requires a capture-bearing leaf to
   declare an attestation basis, a confinement and an upstream — and the add-on
   can honestly answer none of those, so this is not a one-field change.
2. **A new declared field naming the imported datablocks and their digests.**
   The strongest statement — "these bytes came in from outside and here is what
   they hash to" — and the most work: a field in `registry.yaml`, in the MAC, in
   the validator, in a migration, plus enumeration in `adapter/scene.py`. It is
   also the only option that says something *positive* rather than declaring an
   absence.
3. **Extend `declared_uncaptured` (WO-E2) to the plugin door.** The machinery
   already exists — an absence set carrying the scope it enumerated over and the
   method it used — and "the image datablocks in this .blend that this
   integration did not produce" is exactly an absence set with a scope. ⚑ But
   WO-E2 built it over a ComfyUI `/history` enumeration and its
   `enumeration_method` vocabulary has no member for `bpy.data`.

**Recommendation: option 3, and settle the scope rule in writing first**, the
way WO-E2 did — its `docs/canon/DECLARED_UNCAPTURED.md` commit landed before its
implementation commit, and that is why its closure conditions are decidable
rather than asserted. Recorded as a recommendation, not taken: it is a founder
call about what a leaf is.

---

## Verdict

**GATE PASSED** — `bash scripts/e7-gate.sh`, thirteen stages, **58 shell checks
ok / 0 FAIL / 0 inconclusive**, whole transcript in `.run/e7/gate-final.txt`.
Inside it, the three-way comparison is **98 checks ok / 0 FAIL** over 105
columns, and the add-on suite in `/data/scruple-blender` is **330 passed**.

| what the work order asked for | outcome |
|---|---|
| the **add-on alone**, talking to the server directly, no gate | **PASS** — Blender 4.2.23 with the shipped zip on the **manifest** path, signed in against `:3902`, `SCRUPLE_COMFY_HOST_DIR` unset so no declaration is written and no gate exists. The add-on's own `save_post` / `render_write` / `render_complete` handlers did the capturing. |
| **Desktop Studio alone**, no addon | **PASS** — WO-D4's `comfy-generate`, unchanged, no host fixture, leaf reads `blind` |
| **both** | **PASS** — WO-E6's `blender-generate`, unchanged, leaf reads `supplied` |
| a leaf from each, side by side, and exactly which fields differ and why | **PASS** — `scripts/e7-leaf-diff.py`, and it does not list the interesting columns: **every one of the 105 columns of `iterations` is in exactly one of five classes, and an unclassified column is a FAILURE** |
| they differ **only** in the fields `docs/BLENDER.md` predicts | **PASS on the substance, and the document is wrong in two places** — `workflow_hash` is non-null on all three (above), and two real differences the table does not predict are asserted so they stay visible (E7-5, E7-6) |
| no two of them read the same where they should differ | **PASS** — 98 checks, 0 fail |
| **Control:** a field that distinguishes two of the three must change when the thing it describes changes | **PASS, three times over** — see "The controls" |
| ⚑ row 1 at the top of the report | **done, above** |
| fold every E-series finding into `docs/STATE.md` | **done** — §0, §1, §4.7–4.11, §5, §6, §7, §8, and a new **§9** register of every finding in the series with its owner |

---

## The three leaves

Printed by `sqlite3` from the shell, in the gate's stage 9:

```
  id   kind      scheme  workflow_hash  model_fp      host      host_semantics  basis
  749  workflow  v2      f6597e5aff6c   c6c3638ac614  blender   supplied        stale    C  both
  751  workflow  v2      e24bfd0ea578   c6c3638ac614  (null)    blind           stale    B  desktop alone
  753  workflow  v2.2    52be7d745890   (null)        (null)    (NULL)          (null)   A  add-on alone
```

All three re-hash from the bytes on disk with `sha256sum`, and all three have a
row in the **witness's own sqlite file** — a different service, a different
database — read with `sqlite3` outside node.

⚑ **B and C carry the byte-identical `model_fingerprints_hash`.** Two runs, two
different generations, the same weights — and the field that reads the weights
agrees on them to the byte. That is asserted as its own pattern
(`A-null-B-set-C-set-and-B-equals-C`), because a fingerprint that differed
between two loads of the same file would mean the column was reading something
other than the file.

---

## Field by field, and why

The comparator's five classes. The point of naming all 105 columns is that
**"they differ only in the fields the table predicts" is not provable by listing
the fields that came out interesting** — a column this file does not name is a
failure, and the next migration that adds one forces somebody to decide.

### AXIS — the claims in `docs/BLENDER.md`'s table

| claim | columns | A | B | C |
|---|---|---|---|---|
| **byte coverage of the AI step** | the whole capture block: `attestation_basis`, `attestation_profile`, `storage_confinement(+_source)`, `upstream_identity`/`_continuity`/`_uncaptured_reason`/`_source`, `uncaptured_enumeration_method`/`_scope`/`_scope_source`, `declared_uncaptured(+_hash,+_count)`, `component_id`, `component_counter`, `resolution_witness_endpoint`, `resolution_settlement_deadline`, `resolution_retention_policy_digest`, `settlement_clock(+_authority,+_observed_at)`, `evidence_retained_until`, `input_hash` — 24 columns | all **NULL** | all set | all set |
| …and the producer's own MAC | `component_verified` | **0** (and not null: a submission with no §4.3 envelope is *recorded* as unverified) | 1 | 1 |
| **model fingerprints** | `model_fingerprints`, `model_fingerprints_hash` | NULL | set | set, **equal to B's** |
| **the graph** | `workflow_hash` | ⚑ **set** — the table says "no" | set | set — all three distinct |
| **scene semantics** | `host`, `host_adapter`, `host_evidence_type`, `host_evidence`, `host_evidence_hash` | NULL | NULL | set |
| …the declared level | `host_semantics` | ⚑ **NULL** | **`blind`** | **`supplied`** |

### AGREE — what makes the three comparable at all

`leaf_kind` (`workflow`), `output_kind`, `output_content_type`, `witnessed`,
`canonicalization_profile` (`jcs-2`), `mime_declared`, `input_artifacts` (`[]`),
`seal_state`, `workflow_publication`, `prompt`, `output_bytes`,
`leaf_signature_state` (🔴 `unsigned` on all three — the scratch witness runs
with H-1 signing disabled, STATE.md §4.1), and 40 more that are NULL on all
three and are **named** so that a future writer filling one shows up as a change
rather than as a surprise.

A difference in this class would mean the comparison was between two different
kinds of record and the rest of the table was moot.

### PRODUCT — which product made the leaf

| column | A | B | C |
|---|---|---|---|
| `baseline_hash` | `22e97c93c1d8…` | `52605d8a086c…` | `52605d8a086c…` |
| `project_id` | 13 | 12 | 12 |

⚑ **`baseline_hash` is the one column that names which product made the leaf.**
It is the tamper surface hash of the integration that submitted — the add-on's
own files for A, `app/comfy/` for B and C. A verifier **can** tell the two
products apart, but only by resolving this against a baseline registry, never
off the leaf alone. It is reported rather than excluded for exactly that reason.

### UNPREDICTED — real differences `docs/BLENDER.md` does not predict

Asserted to be **present**, so they stay visible rather than being absorbed into
one of the classes above. Findings E7-5 and E7-6.

### IDENTITY — differs by construction, carries no claim

`id`, `run_sequence`, `timestamp`, `witness_timestamp`, `leaf_hash`,
`output_hash`, `witness_id`, `witness_signature`, `settlement_observed_at`.

---

## The controls

A green comparison with no control proves only that it cannot fail.

**1. The comparator can fail.** `--self-control` feeds the **same leaf** in as A
and as B. **33 checks go red** — every capture-block column, `component_verified`,
both fingerprint columns, `workflow_hash`, `host_semantics`, `baseline_hash`,
`project_id`, `leaf_scheme`, `machine_manifest_hash`. The five host-document
columns correctly stay **green**, because they are NULL on A and on B alike and
were never the thing that told those two apart. A control that reddened
everything would be telling us less, not more.

**2. `model_fingerprints_hash` reads the WEIGHTS.** The field that separates A
from B and C is put through WO-D4's `model-swap` — same filename, same length,
same safetensors header, different weights — on B's own scenario. The
fingerprint **moves** — `c6c3638ac614…` → `58d20177c1878…` — and A still has
none, because the add-on never saw any weights to fingerprint.

**3. `host_semantics` reads the ANNOUNCEMENT.** The field that separates B from
C is put through `blender-does-not-announce` on C's own scenario: the add-on
stays installed, enabled and declared, and says nothing about that generation.
C's leaf stops saying `supplied` and says **`declined`**. B's `blind` does not
move — B has no add-on to silence — and A still says **nothing at all**, which
is the finding at the top of this document arriving as a control.

**4. RED BEFORE THE CHANGE.** Resolved from the change and not from HEAD: a
worktree at the parent of the commit that adds `scripts/e7-addon-alone.py` has
neither that file nor `scripts/e7-leaf-diff.py`, so that tree cannot produce
leaf A and cannot compare anything. ⚑ This is the **weakest** control in the
work order and it is labelled as such: E7 adds no application code, so there is
no behaviour that was wrong before and right after. The three above are the real
ones.

---

## What was built

| file | what |
|---|---|
| `scripts/e7-addon-alone.py` | runs **inside** Blender: sign in through the SDK's auth cache, build a scene around an imported AI output, save, render, wait for the add-on's worker to go quiet, report. It calls no `witness_*` function — the add-on's own handlers do the capturing. |
| `scripts/e7-addon-graph.py` | rebuilds the graph the add-on committed to, **outside** Blender, from the add-on's own builders and its own canonicalizer. Not a second implementation; its output has to equal the leaf's `workflow_hash` and can only do that by being the same code. |
| `scripts/e7-leaf-diff.py` | the three-way comparison. Five classes, 105 columns, an unclassified column is a failure, and `--self-control`. |
| `scripts/e7-prefs-probe.py` | the same zip on both install paths (finding E7-2) |
| `scripts/e7-worker-stop-probe.py` | the add-on's own `WitnessWorker`, outside Blender (finding E7-3) |
| `scripts/e7-leaf-of.py`, `scripts/e7-graph-mentions.py` | two small readers the gate calls |
| `scripts/e7-addon-key.ts` | the add-on's own tenant and key — deliberately **not** the desktop's, because comparing two products under one tenant would be comparing one product with itself |
| `scripts/e7-gate.sh` | the gate |

**Not built, on purpose:** no scenario, no driver change, no IPC channel and no
change to `app/`. The add-on-alone path has no Electron in it, and putting it
behind `scripts/desktop-run.mjs` would have meant an app in a run whose whole
claim is that there isn't one.

### Three decisions worth reading

**1. The add-on's own handlers, not the flow functions.** The obvious shortcut
was to call `flow.witness_render(client, scene)` from the script. That would
have measured this file. So the script saves and renders, and Blender's
`save_post` / `render_write` / `render_complete` fire the add-on's handlers on
its own worker thread, exactly as they would while a user carried on working.

**2. It waits for quiescence instead of calling `stop()`.** Discovered by
failing — see E7-3. Stopping the worker the moment the render returns
under-counts the add-on's captures, and a script that did it would have been
measuring its own impatience. The wait is until the assurance list stops growing
for 8 s, bounded.

**3. The two add-on runs are built to produce the SAME graph.** Same scene name,
same camera, same frame, same filenames — so the only thing that differs is the
AI image inside. That makes the invariance measurement possible and it also
means the leaves cannot be told apart by `workflow_hash`, which is why the gate
picks them by the add-on's **own receipt** and then checks the graph against it.

---

## Findings

### ⚑ E7-1 — the standalone add-on's leaf does not declare what it did not observe

At the top of this document. `docs/STATE.md` §4.7.

### ⚑ E7-2 — the add-on's own Settings UI does not bind on the path it ships on

`ScrupleAddonPreferences.bl_idname` is the literal string `"scruple_blender"`.
That is the module name Blender uses on the **legacy** `scripts/addons/` path.
Through `blender_manifest.toml` — the path WO-E3 made work, and the one every
4.2+ user gets — the module is `bl_ext.user_default.scruple_blender`, the two
strings do not match, and Blender never binds the class.

Measured with a control, because a probe that failed on both paths would be
telling us about something else. Same zip, same Blender 4.2.23:

| install path | module Blender reports | `.preferences` |
|---|---|---|
| legacy `scripts/addons/` | `scruple_blender` | **bound** — `ScrupleAddonPreferences`, `api_key` settable |
| **manifest (what ships)** | `bl_ext.user_default.scruple_blender` | **None** |

Three consequences:

1. On the shipping path the add-on's Settings panel **draws nothing**: no API
   key field, no base URL field, no verbose-logging toggle, and no SDK
   provenance line.
2. `get_base_url()` falls through `_addon_prefs() → None` to the SDK default,
   which is **`https://scruple.ai`** — production. A user who could set it
   cannot.
3. What keeps the product working at all is the fallback: `get_api_key()` and
   `get_base_url()` read the SDK's on-disk auth cache, which is what the
   `scruple.sign_in` operator writes. WO-E7's own add-on runs sign in through
   exactly that path, so this finding is not hypothetical — it is the reason the
   script writes the cache instead of setting a preference.

The fix is one line — `bl_idname` must be the module the class is registered
under (`__package__`) — and it is **not taken here**. It is the add-on repo's
product surface, it moves the add-on's tamper surface hash and therefore every
baseline in the E-series fixtures, and it deserves its own gate rather than
being smuggled in under a close-out. `scripts/e7-prefs-probe.py` is the control
it needs, already written.

⚑ The add-on's own suite has 330 tests and none of them catches this, because
they exercise `ScrupleAddonPreferences` as a class rather than as a class
Blender bound to a module.

### ⚑ E7-3 — the add-on's in-memory worker drops queued captures when it stops

`adapter/handlers.WitnessWorker._run()`:

```py
while not self._stop_flag.is_set():
    job = self._q.get()
    if self._stop_flag.is_set():
        break            # <- whatever it just pulled is dropped
    job()
```

`stop()` sets the flag and puts a sentinel on the queue, so a capture still
queued when it is called **never runs** — and because it never reached the SDK
it is not in the on-disk retry queue either. `unregister()` calls `stop()`, so
the losing case is a capture taken shortly before Blender quits or the add-on is
disabled: exactly the case `adapter/baseline_cache.py`'s store-and-forward story
is written for.

Measured on the real class, outside Blender
(`scripts/e7-worker-stop-probe.py` — `adapter/handlers` imports `bpy`
defensively, so it is importable with `bpy` absent and the class under test **is**
the class that runs in a user's Blender):

```json
{"submitted": ["first", "second"], "ran": ["first"], "dropped": ["second"]}
```

⚑ **It bit this work order first.** The first exploratory add-on run stopped the
worker as soon as the render returned and reported **two** captures; the same
Blender, same scene, waiting for quiescence, reports **three**.

### E7-4 — one still render lands two leaves, with two different graphs

`render_write` and `render_complete` **both** fire for a single
`bpy.ops.render.render(write_still=True)`, and the add-on witnesses the same
file on each. The two leaves are not duplicates: their graphs differ.

```
  render_write     {…,"frame":173,"trigger":"render_write"}      → one leaf
  render_complete  {…,          "trigger":"render_complete"}     → another
```

`render_write` carries the frame (`scene.frame_current`, read in the handler)
and `render_complete` does not (`witness_render` is called with `frame=None`).
Both are asserted, pinned to A1's own output bytes so that A2's identical graphs
cannot satisfy them.

⚑ **The first version of those two assertions expected `1` and measured `2`**,
because they counted rows by `workflow_hash` alone and A1 and A2 are built to
produce the same graph. The assertion was wrong, not the system — which is the
row-1 result arriving early, in the shape of a gate tripping over it.

This is not WO-E6's E6-4 (one generation seen by two **surfaces**). It is one
file seen by two **handlers**, and whether the product wants two leaves for one
render is a question nobody has asked.

### E7-5 — the two products emit different leaf schemes

`leaf_scheme` is **`v2.2`** from the add-on and **`v2`** from the desktop
component. A leaf scheme governs which fields enter the preimage and in what
order, so these two leaves are not merely differently populated — they are
differently **constructed**, and a verifier replaying one has to know which.
`docs/BLENDER.md`'s table does not predict this and neither does
`docs/HOST-HOOK.md`.

### E7-6 — and one column points the other way

`machine_manifest_hash` is **set** by the add-on and **NULL** from the desktop
component. On that one column the *standalone* product records more: Blender's
version, the enabled add-on list and the workflow, hashed with the SDK's own
canonicalizer. The gated path records none of it.

Also measured: it is **identical** across A1 and A2, so it is not a channel
through which the AI step could leak onto the leaf either.

### E7-7 — the add-on's live modules are top-level, not attributes of its package

`__init__.py` puts its own directory on `sys.path` and does `from adapter import
handlers`. So the module holding the worker thread, the handler registrations
and the state bag is **`adapter.handlers`** — *not*
`bl_ext.user_default.scruple_blender.adapter.handlers`. Importing the dotted
name loads a **second copy**: a worker that was never started, a state bag
nothing writes to, and a script that reports an empty run for a Blender that
witnessed perfectly well.

Recorded because it cost this work order an hour and because the two leaves that
run *did* write (`729`, `730` in the scratch database) are still there — the
captures happened; only the report was blind to them. The comment at the import
site in `scripts/e7-addon-alone.py` is longer than the import for that reason.

### E5-x, again — do not edit a gate script while bash is running it

WO-E5 recorded that fixing a line while the gate was running shifted the script
under bash's byte offsets and corrupted its own transcript. **The same thing
happened here**, in the same way: correcting the two E7-4 assertions mid-run
killed the run at stage 8 with `syntax error near unexpected token '*'`. The
first run is kept unedited as `.run/e7/gate-run1-selfcorrupted.txt`; the gate was
then committed and re-run untouched into `.run/e7/gate-final.txt`, and every
number in this document is from the second.

---

## What this does NOT cover

- **The add-on-alone leaf was never fixed, only measured.** E7-1 names three
  options and recommends one; none is implemented, and the work order did not
  ask for one. It is a change to the server's leaf.
- **Three of the add-on's capture points, out of everything it does.**
  `save_post`, `render_write` and `render_complete`. Export, the paid actions,
  C2PA, chain-lock, the dashboard panel and reconcile/settle have unit tests in
  the add-on repo and no leaf in this sandbox behind them.
- ⚑ **The comparison is of three leaves, not of three products.** B and C each
  produce **two** leaves per generation (E6-4) and the add-on produced **three**
  captures per run (E7-4); the gate names which one it compares and why, but a
  claim about "the leaf a product emits" is a claim about one row out of several.
- **One artifact shape.** A 64×64 PNG through a 7 KB upscaler, rendered at one
  Cycles sample. Nothing here says anything about a real generation or a real
  render, and nothing should.
- 🔴 **Every leaf B and C produce reads `attestation_basis: stale`**, and A's is
  NULL because it has no capture block at all. `verified` is unrepresentable on
  the desktop profile by construction (migration 053) and nothing here went near
  it.
- 🔴 **Every leaf here reads `signature.state: unsigned`.** The scratch witness
  runs with H-1 leaf signing disabled; `STATE.md` §4.1, unchanged, still needs a
  human with authority over that process.
- **Every Blender measurement is on an emulated CPU** (E3-2, `aarch64` under
  `qemu-user`).
- **`npm run gate` (D1…D7) was not re-run**, and neither was WO-D5's audit
  sweep — the same omission WO-E5 named. What *was* re-run is in the gate's
  stage 10.

---

## How to re-run

```bash
cd /mnt/corpus/scruple-desktop
npm run e7                      # the whole thing, eleven stages
npm run e7:diff -- --a 753 --b 751 --c 749                 # the comparison alone
npm run e7:diff -- --a 753 --b 751 --c 749 --self-control  # and its control
python3 scripts/e7-prefs-probe.py        # (inside blender) finding E7-2
python3 scripts/e7-worker-stop-probe.py  # finding E7-3
```
