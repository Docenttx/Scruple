# `model.write`, for a vendor whose topology we do not choose

**Status:** Built and demonstrated. WO-20 of `WO-SERIES-2-PROVING-IT.md`.
**Binds:** `CANON_SKELETON.md` §4 (the hook contract) and §5 (the adapter
rule), `PLACEMENT_AND_SURFACES.md` §4/§5 (declared vs effective placement, the
assurance function), `KOHYA_REPLACEMENT.md` §1 (why a checkpoint is different
from a render).
**Code:** `packages/scruple-api/scruple_api/model_write.py` (the evidence
shape, zero network), `packages/scruple-host-sdk/scruple_host_sdk/model_write.py`
(the witnessing), `packages/scruple-host-sdk/tests/test_model_write.py`,
`examples/vendor-training/`.

---

## 0. The short version

`model.write` now has **two implementations against one contract** — Kohya's
`safetensors.torch.save_file` call site and a plain PyTorch `torch.save` loop —
and works across **three placements**, resolved rather than declared. A vendor
reaches a witnessed checkpoint in four functions and five calls — 104 lines
between the markers in `examples/vendor-training/vendor_training_backend.py`, of
which 30 are imports and most of the rest are constructor arguments one per
line.

The contract fitted the second trainer. What it did **not** fit is a *sharded
directory* checkpoint, and that misfit is reported rather than bent (§5).

Four findings came out of it, in descending order of how much they matter:

1. **`header_hash` has nowhere to live on a leaf.** Not in
   `lib/leaf/registry.yaml`, not in `/v2/witness`'s accepted body, not in the
   MAC preimage. It survives today only in the legacy Kohya route's own tables
   and in the sidecar's opaque `evidence` block. §4.
2. **A training recipe cannot be hashed reproducibly across languages.**
   `workflow_hash` is `sha256(canonicalize(doc))`, `canonicalize` uses the host
   language's JSON number formatter, and a learning rate of `1e-5` is
   `0.00001` in JavaScript and `1e-05` in Python. §6.
3. **`ServerLibraryIntegration` stamps `fidelity: as-delivered` on every
   leaf.** Correct for an inference handler. False for a checkpoint, which was
   written to disk and delivered to nobody. §3.
4. **`capture()` cannot carry a checkpoint at all** — it base64-inlines the
   file and refuses over 25 MB. The smallest LoRA is ~9 MB; a fine-tune is
   gigabytes. §3.

---

## 1. Why a second implementation was the whole task

`CANON_SKELETON.md` §4.1 already says it: `model.write` is "specified from a
single integration". WO-5's mapping exercise established what that means — **a
hook with one implementation describes that integration rather than a
contract**, and the shape of the one implementation gets mistaken for the shape
of the hook.

So the second one was chosen to be different in the ways that could embarrass
the first: a different framework, a different save function, a different file
*format*. `torch.save` writes a zip-wrapped pickle.

It fitted, and three things fell out that Kohya alone could not have shown:

- **`header_hash` is a property of the format, not of the hook.** A pickle has
  no safetensors header, so the structural fingerprint that
  `KOHYA_REPLACEMENT.md` leans on — the thing that distinguishes a
  metadata-only edit from a re-train — simply does not exist for it.
  `CheckpointFacts.header_hash` is `None`, which is a recorded absence and not
  a guess. **A vendor on the second path gets a strictly weaker leaf, for
  reasons nothing in the integration can fix.**
- **`torch.save` is not a checkpoint call.** It is a generic serializer: the
  same function writes optimizer state, a resume file, a cached tensor.
  `install_torch_save_hook` takes an `only_paths_under` scope for that reason.
  Kohya's call site needed no scoping, which is exactly why the one-integration
  specification had no notion of one.
- **A torch pickle has no media type.** Not "we did not look" — there is none.
  So `mime` is absent and the route records `mime_declared: false`.
  `application/octet-stream` here would be the same false declaration five of
  the six shells made.

Both are the same hook, the same `kind`, the same fidelity and the same run
commitment. `test_both_trainer_shapes_reach_the_same_contract` asserts exactly
that, and asserts the one difference beside it.

---

## 2. Three placements, one derivation, and a refusal

**We do not get to choose a vendor's topology.** Studio's answer to Kohya —
delete the GUI, expose a job-submission API — is available to *us* because we
own the product surface (`KOHYA_REPLACEMENT.md` §4). A vendor may have a UI
they cannot remove, a contract that promises a shell, or an image they do not
build. Assuming Studio's topology here is the specific mistake this WO exists
to prevent.

So `ModelWriteIntegration` takes the topology as an input:

| Vendor's shape | Declared | Enforcement | Effective | Surface | P1 | Leaf |
|---|---|---|---|---|---|---|
| the vendor's backend orchestrates training | `server-library` | `no-tenant-code` | `server-library` | `in-process-callback` | **holds** | `passthrough` |
| the vendor can isolate the trainer | `sidecar-gate` | `isolated-namespace` | `sidecar-gate` | `filesystem-watch` | conditional | `passthrough` |
| the vendor can do neither | anything | `none` | **`unattested-client`** | — | **fails** | **none** |

Nothing above is written down anywhere in the module. Every cell comes out of
`resolve_placement()` and `assurance_for()` — the same two functions the server
calls and the predicate validator recomputes with. WO-2 established that these
are recomputed, never declared, and DEFECT-1 in the axes doc is the record of
what happens when a host can grade itself.

Two properties of the refusal are worth naming separately, because both are
easy to get subtly wrong:

- **It costs no counter.** `witness_checkpoint()` refuses before anything is
  hashed, MACed or sent. A refusal that spent a counter would leave a gap the
  component could never account for.
- **It costs no key.** `provision_or_refuse()` resolves the placement *before*
  spending the one-time provisioning token, so a refused deployment never seals
  an IK onto a filesystem the measured party can read — which is H-4 §7
  probe 3's exact condition. `KOHYA_REPLACEMENT.md` §1 records this as the
  runner's most important behaviour and it is worth having twice.

And the row a vendor will misread: **`server-library` earns P1 for free and
still yields `passthrough`.** Nothing lifts a leaf to `verified` except an
attestation chained to a vendor root, which is a property of the compute.

---

## 3. Why this is not `server_library.py` with a different `kind`

`ServerLibraryIntegration` already accepts a `declared_placement` and already
maps `kind == "model_write"` onto `hook: model.write`. It looks like it covers
this. Three things stop it, and none of them is a defect in that file — they
are what it means that `model.write` had one implementation.

**It stamps `fidelity: as-delivered` on every leaf.** Correct for an inference
handler, where the response body *is* the artifact. On a training run nothing
was delivered: the trainer wrote a file and the handler hashed the file. The
honest value is `as-written` — "a third party holding this file can re-derive
the hash" — and `as-delivered` asserts something else that happens not to be
true. This is a live correctness bug for any `model.write` leaf produced
through that path today, and the fix belongs with the seam in §8.

**It stamps `surface: in-process-callback`.** True for a vendor whose backend
runs the trainer, false for one who isolated it and watches the volume. Surface
does not affect assurance — it affects coverage — but a leaf that misdescribes
how its bytes were seen is a leaf whose coverage cannot be reasoned about.

**`witness_file()` cannot carry a checkpoint.** It routes through `capture()`,
which base64-inlines the file and refuses anything over 25 MB.
`observe_checkpoint()` streams a SHA-256 and sends no bytes; the leaf is
zero-content and the checkpoint stays where the trainer put it.

What is **not** duplicated: `component_preimage` is imported, because two
implementations of a preimage are two preimages; `PlacementRefused` is
imported, because a second refusal exception is a second vocabulary; and the
network call is still the single `http.submit`, so the queue stays in the
failure path by construction.

What **is** duplicated is about forty lines of submission assembly, and it is
recorded in the module header rather than tidied away. §8 says where it goes.

---

## 4. What the leaf registry already carries, and what it lacks

Checked against `lib/leaf/registry.yaml` rather than invented alongside it.

| Commitment | Registry field | Verdict |
|---|---|---|
| hyperparameters / training recipe | `workflow_hash` | **Fits, and the registry already says so** — "the training recipe for `kind=model_write`: on a training run the recipe is what the graph is on a generation run." No new field needed. |
| base-model fingerprint | `model_fingerprints_hash` | **Fits exactly** — "binds the actual weights loaded, not the filenames asked for." A training run loads base weights; that is what this field is. |
| dataset root | `input_hash` | **Fits on the wire, with a gap underneath.** The dataset lands as one `{kind: "dataset", hash}` entry in the `inputs` array, which the shipped preimage handles unchanged. But **the dataset-root preimage itself is defined nowhere in the registry** — it is defined in `scruple_api.model_write.dataset_root_hash` and repeated here, and it should be a registry entry. |
| checkpoint `header_hash` | **none** | **Missing entirely, in four places at once.** |

### 4.1 The dataset-root preimage, stated so it can be moved

```
manifest  = { posix relative path : sha256 hex of the file bytes }
            for every REGULAR file under the dataset root, recursively
preimage  = JSON of that manifest, top-level keys sorted ascending,
            no whitespace, non-ASCII left literal
root_hash = sha256(preimage)
```

Deliberately the same rule as `model_fingerprints_hash` — top-level sort,
values verbatim — so a verifier learns one rule and applies it twice.
**Symlinks are not followed** and are reported separately: following them would
make the commitment depend on something outside the directory, and a dataset
that hashes differently depending on what a link points at today is not a
commitment.

### 4.2 `header_hash` — the real gap

The safetensors header is every layer name, shape and dtype. Hashed separately
from the content, it distinguishes a metadata-only edit (header hash unchanged,
content hash changed) from a structural change (both changed). That distinction
is the whole reason `KOHYA_REPLACEMENT.md` insisted it survive the move out of
the pod — losing it would have made the re-placement a *net evidence
regression*.

It is nonetheless absent from every part of a `/v2` leaf:

| Place | State |
|---|---|
| `lib/leaf/registry.yaml` | **no such field.** The nearest thing is `lib/types.ts:88`, where `header_hash` is a key *inside* a `model_fingerprints` entry — i.e. the base model the run loaded, not the checkpoint it wrote. |
| `app/api/v2/witness/route.ts` Zod body | **not accepted.** Zod strips unknown keys silently. |
| `component_preimage()` (×3: `server_library.py`, `lib/leaf/componentPreimage.ts`, `services/scruple-capture/src/leaf.ts`) | **not read.** So it is not covered by the ratchet MAC. |
| `services/scruple-capture/kohya/checkpoint-watch.ts` | computed, and emitted into the surface's opaque `evidence` block. |
| `app/api/apps/kohya/witness/route.ts` + `training_runs` / `checkpoints` | stored — on the **legacy** route whose ceiling is `witnessed: false`. |

**So the only place `header_hash` is durably recorded today is the one path
that may never produce a leaf.**

This module sends it as `capture.header_hash` — so a server that grows a slot
needs no client change — and **says on every outcome that it is not covered**:
`ModelWriteOutcome.header_hash_covered` is `False`, and
`test_header_hash_rides_on_the_wire_and_is_not_covered_by_the_mac` pins it.
When someone closes the gap, that test fails and tells them to flip the flag.
A gap that goes quiet when it is fixed is a gap nobody closes.

**Closing it is:** one registry entry (`introduced_in: v2.5`, `surfaces:
[submit, record, storage]`, preimage stated), one Zod field, one column, and
the same one line in each of the three preimage implementations plus their
shared vector file. None of those five files was in WO-20's scope, and the
change is breaking for the preimage — it wants a leaf scheme, not an edit.

### 4.3 A smaller one, recorded and not acted on

A training run writes **many** checkpoints, and nothing on the leaf carries the
step or epoch. `run_sequence` is chain position, not training step. Today the
step survives only inside the safetensors `__metadata__`, i.e. inside the
structural summary that is itself uncovered. Worth a field the day §4.2 gets
one; not worth one on its own.

---

## 5. The misfit: a checkpoint that is a directory

`save_pretrained()`, `accelerate`, and every sharded fine-tune write a
**directory** — `model-00001-of-00003.safetensors` and friends, plus optimizer
state, plus a config. That is a large fraction of real training, and the
contract does not fit it.

`content_hash` is one hash of one file. Every way of giving a directory one
invents a preimage `lib/leaf/registry.yaml` does not define, and an invented
preimage is one a third party cannot reproduce. `observe_checkpoint()`
therefore **raises `DirectoryCheckpointError`** rather than answering, and
`test_a_directory_checkpoint_is_refused_rather_than_answered` holds it there.

The three ways it could be closed, none of which is a code change alone:

1. **A leaf per shard.** Honest and immediately available — each shard is a
   file with its own header. What it loses is the *set*: nothing says these
   nine leaves are one checkpoint, and a missing shard is invisible.
2. **A manifest leaf.** One `model_write` leaf whose content hash is over a
   shard manifest, with the shards as `inputs`. This is a new preimage and a
   new registry field, and it changes what `content_hash` means on that leaf
   from "the artifact" to "a description of the artifact" — which is a real
   semantic change that a receipt would have to show.
3. **Refuse the shape.** Defensible and probably wrong: it refuses a large and
   growing share of legitimate training for a reason that is ours, not theirs.

This is a **product decision about what a checkpoint is**, and the skeleton
does not make it — the same way §7 of `CANON_SKELETON.md` declines to decide
what a CAD file's marked artifact should be. Recorded here so the next person
does not rediscover it by shipping option 1 by accident.

---

## 6. Floats: the training-specific way a preimage stops being reproducible

`workflow_hash`'s preimage is `sha256(canonicalize(doc))` — recursive key sort,
no whitespace — and on `kind=model_write` the registry says the training recipe
**is** that document. `canonicalize` serialises scalars with the host
language's own JSON number formatter, and the two languages that have to agree
do not:

| value | JavaScript `JSON.stringify` | Python `json.dumps` |
|---|---|---|
| `1e-4` | `0.0001` | `0.0001` | 
| `1e-5` | `0.00001` | `1e-05` |
| `5e-6` | `0.000005` | `5e-06` |
| `1.0` | `1` | `1.0` |
| `1e16` | `10000000000000000` | `1e+16` |

A ComfyUI graph is mostly integers and strings and mostly gets away with it.
**A training recipe is learning rates.** `1e-5` is the most ordinary value in
the file, and the server (TypeScript) and a third-party verifier (anything
else) would compute two different `workflow_hash` values for an identical
recipe — which reads exactly like a tampered document, and is the single
hardest kind of evidence failure to diagnose.

Note that the estate already learned this once. §10 C-1 fixed the MAC
preimage's encoding and `ratchet.canonical_preimage` **refuses floats
outright**, saying so in the error text. The workflow preimage never had to
care, because until a training recipe went through it, no document it carried
was mostly floats.

**What was done:** `training_recipe()` commits every float as its shortest
round-trip decimal **string**. `float(encode_number(x)) == x` exactly, and a
string canonicalizes identically everywhere. Integers are left alone, because
they *are* portable and `steps: "1000"` in a receipt would be worse than the
problem. NaN and infinity are refused: JSON has no spelling for them.

**The cost is real** — the recipe's numbers are quoted, and a reader of the
document sees `"1e-05"` rather than `1e-05`. The alternative is a hash nobody
outside our toolchain can reproduce, so the cost is paid deliberately.

**The proper fix is not ours to make here.** `canonicalize()` should refuse
floats the way `canonical_preimage()` does, in both languages, and the recipe
document should say which encoding it used. That is `lib/scruple/canonicalWorkflow.ts`
and a registry entry, and it is breaking for any existing leaf whose graph
contains a float — ComfyUI's `denoise: 1.0` is one, so this is not
hypothetical for the canvas path either. **Flagged as a live cross-path
correctness issue, not as a training curiosity.**

### 6.1 Nothing compares the two `workflow_hash` values

The component computes the recipe hash and puts it in `capture.workflow_hash`,
which **is** in the MAC preimage. The route recomputes it independently from
`body.training` via `hashGraphOrTraining`. **Nothing checks that the two
agree.**

The route already does exactly this check for `model_fingerprints` vs
`model_fingerprints_hash` and refuses on disagreement, with the right reason
attached: "a caller that sent both is asserting they agree, and if they do not,
one of the two is wrong." The same argument applies here and the same refusal
should exist. `app/api/v2/witness/route.ts` was outside this WO's scope.

---

## 7. What a vendor is told, in the words they should hear it in

Reproduced from `examples/vendor-training/README.md` because it is the part
most likely to be softened by whoever writes the commercial page next.

> **You can get the bytes. You cannot leave the record undisturbed.**

ComfyUI's artifacts are retrieved through a surface the gate owns, so the gate
can await a leaf before forwarding a byte. **Fail-closed is available there.**

**A checkpoint is a file.** It is written to a volume the trainer's own process
owns, and every ordinary way of collecting it — a file browser, JupyterLab,
`scp`, a remounted network volume — reads bytes off disk without crossing
anything we could stand in front of. **There is no point at which bytes can be
withheld pending a leaf.**

Three consequences, and they must be stated together or the third sounds like
a consolation prize:

1. `watch` **is** the capture, not a complement to a gate. On ComfyUI the
   watcher covers what the gate cannot; here it is the whole thing.
2. There is **no fail-closed point**, on any placement, including
   `server-library`. Removing tenant code execution buys P1; it does not buy a
   chokepoint, because the chokepoint was never on the network.
3. What replaces it is the **counter in the clear**. A suppressed event arrives
   as a gap; a removed capture arrives as silence. Both are visible without a
   separate protocol, obtained free from the key schedule (H-4 §4.2).

That is a weaker guarantee than a gate's, stated honestly, and it is the
guarantee payments actually ships: a terminal protects what flows through it,
and a merchant who stops using the terminal shows up as a merchant who stopped
transacting.

**An overstated guarantee in vendor material is worse than a narrower true
one**, because the vendor will design against it — and a vendor who believed
there was a chokepoint would build a product whose safety story has a hole in
exactly the place they stopped looking.

---

## 8. Open, and where each one goes

| # | Item | Where it lands |
|---|---|---|
| 1 | `header_hash` has no registry field, no body field and no preimage slot | `lib/leaf/registry.yaml` + `/v2/witness` + three `component_preimage` implementations + their vector file. Wants a leaf scheme (§4.2). |
| 2 | The dataset-root preimage is defined in the SDK and not in the registry | `lib/leaf/registry.yaml`, as a documented preimage under `input_hash` (§4.1). |
| 3 | `canonicalize()` accepts floats; `canonical_preimage()` refuses them | `lib/scruple/canonicalWorkflow.ts` and `scruple_api/manifest.py`. Affects the canvas path too (§6). |
| 4 | `capture.workflow_hash` and the server's recomputation are never compared | `app/api/v2/witness/route.ts`, beside the `model_fingerprints` disagreement check (§6.1). |
| 5 | `ServerLibraryIntegration` hardcodes `as-delivered` and `in-process-callback` | A `submit_observation()` seam taking surface and fidelity as arguments; both classes then call it, and §3's forty duplicated lines go away with it. |
| 6 | A sharded/directory checkpoint has no answer | Product decision, §5. Do not close it by shipping option 1 quietly. |
| 7 | The watcher approximates `IN_CLOSE_WRITE` by quiescence | Same §10 C-10 remainder the ComfyUI watcher carries, and worse here: on a checkpoint the two-hashes record is indistinguishable from the tamper case. The fix is real inotify. |
| 8 | No probe run behind any of this | DEFECT-2 stands. A well-formed profile is what to probe, never evidence that probing would pass — this WO produced a contract and a demonstration, not a conformance result. |
