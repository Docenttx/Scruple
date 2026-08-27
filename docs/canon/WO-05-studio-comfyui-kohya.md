# WO-5 · Scruple Web Studio (ComfyUI + Kohya) to Standard v1.7

**Status:** Plan, for review. No code written.
**Depends on:** the `/v2` surface and client SDK from `CANON_SKELETON.md`.
**Written:** 2026-08-26

---

## 1. Studio is a different shape, and it is the stronger one

Every other integration is a plugin running inside someone else's
application on someone else's machine. Studio is not. ComfyUI runs in a
Modal container Scruple builds; Kohya runs in a pod Scruple provisions.
**Scruple owns the execution environment end to end.**

That inverts the usual difficulty. The clauses that are hardest for a
desktop plugin are the easy ones here:

| Clause | Desktop plugin | Studio |
|---|---|---|
| §3 baseline of the tamper surface | must measure a host we don't control | `container_manifest.py` **already computes exactly this** |
| §2 witness the integration itself | needs a new capture path | the container manifest is that path |
| §12 hardware attestation | the customer's machine, unknowable | Modal H100 CC builds are reachable |
| §2 witness the workflow, not just the file | needs host cooperation | the proxy **already captures the full graph** |

Studio already captures more than any shell: `workflow_api_json`, model
fingerprints, and a container manifest of toolchain SHAs. The desktop
shells capture a file hash.

**A sequencing note that cuts against my earlier advice.** I recommended
Blender as the first integration to merge, on the grounds that it has 81
passing tests and one real headless run. For *extracting the SDK* that is
still right — Blender's `lib/` is the healthiest of the six forks.

But for *first integration to fully meet the Standard*, Studio is the
better candidate, because Scruple controls the substrate and can satisfy
§3, §4 and §12 without asking anything of a customer's machine. The
counter-argument is real and should be weighed rather than waved at:
**Studio has no tests at all.** Blender is verifiable tonight; Studio is
not verifiable until tests exist. That is a genuine trade and it is the
founder's call, not mine.

---

## 2. What Studio actually is

Four live pieces, two dead ones. Established by reading the code, not
the READMEs.

**Live:**
- `app/canvas-proxy/[sessionId]/[[...path]]/route.ts` — intercepts
  `POST /prompt` and `GET /view` at the network layer. This is the real
  ComfyUI integration.
- `lib/canvas/witness.ts` — the witness path behind the proxy.
- `modal/scruple_runner.py` — in-container runner; builds the graph
  capture, model fingerprints, container manifest.
- Kohya: `sitecustomize.py` monkey-patching `safetensors.torch.save_file`
  → `POST /api/apps/kohya/witness`, HMAC-signed.

**Dead, and to be deleted rather than migrated:**
- `research/electron-source/ComfyUI-Scruple` — the node pack.
  `modal/canvas_app.py:116` calls it "dead code" in terms, and it is
  structurally broken as committed: `__init__.py:9` imports
  `.nodes.input_capture`, which needs a `nodes/` package nested inside
  the directory, while the real files are a sibling one level up. It
  raises `ModuleNotFoundError`. Last touched 2026-05-02.
- `external/scruple-nodes` — a fork-management scheme for a third-party
  video-upscaler node. No witnessing code. Not a Scruple integration at
  all; leave it alone, but stop counting it as one.

**Also:** `research/scruple-kohya-image/{Dockerfile,start.sh}` is
superseded — production runs `ashleykza/kohya:latest` via a RunPod
`dockerStartCmd`. But `scruple_safetensors_hook.py` in that same
directory **is live and maintained**. Deleting the directory wholesale
would take the live hook with it.

---

## 3. Verified defects

Each was confirmed by reading the file, not inherited from the sweep.

### 3.1 The Kohya route named "witness" does not witness

`app/api/apps/kohya/witness/route.ts:110` says it plainly:

> We do NOT yet POST to the witness server for a leaf hash from this
> route — the leaf construction still runs through the canonical
> `/api/v1/log/*` ingest surface […] Wiring the pod-side HMAC through to
> a witness leaf is a separate follow-up.

It returns `ok: true` at line 199 regardless. The file's own header
comment at lines 6–7 claims it "POSTs to the witness server for the leaf
hash + HMAC seal." Header and body contradict each other, and the header
is the one that reads like documentation.

Note what this means with `/v1` retired: the canonical ingest surface it
defers to is the one with zero production callers, which is about to be
deleted. This route cannot be left as-is through that change.

### 3.2 Training provenance is designed and not collected

`training_runs` (migration `001_core.sql:88`) provides for
`dataset_path`, `dataset_merkle`, `image_count`, `caption_count`,
`base_model_path`, `base_model_hash`, `parent_run_id`, `lineage_type`,
`parent_checkpoint_hash`, `network_dim`, `network_alpha`,
`learning_rate`, `lr_scheduler`, `optimizer_type`, `max_train_epochs`,
`train_batch_size`.

The live path writes `model_hash`, `header_hash` and
`structural_summary`. Nothing else.

For a training tool this is the whole provenance question. A checkpoint
hash says a file exists; it says nothing about what the model was trained
on. The schema was designed by someone who understood that, and the
capture path never caught up.

### 3.3 Silent degrades in the runner

- `scruple_runner.py:653-661` — container-manifest failure is swallowed
  and `machine_manifest_hash` "just stays ''". A leaf silently loses its
  machine binding. Non-fatal by design; the design predates §3 mattering.
- `"attestation": None` at line 672, commented "populated on H100 CC
  builds." This one is *honest* — it reports absence rather than
  fabricating presence, which is more than the six attestation verifier
  plugins manage. It is a gap, not a violation.
- Model-name fallback fabricates `ModelPatcher_{id()%10000}` — an
  identifier derived from a Python object address, recorded as if it
  named a model. It is stable for no longer than the process.

### 3.4 One shared HMAC secret for every pod and every user

`SCRUPLE_APPS_WITNESS_SECRET` is global. Any pod can witness as any
user. Pre-launch this is a configuration decision; at launch it is a
tenancy boundary that does not exist.

### 3.5 The Kohya hook has never been observed firing

The team's own smoke-test notes leave it explicitly unverified against a
real save. Everything downstream of it is therefore untested in
production conditions.

### 3.6 `forge` is a valid appId with no registry entry

`app/api/apps/[appId]` accepts it; it 503s always, wired through four
files. Delete or implement.

---

## 4. Tasks

Sequenced. Each ends in a state worth stopping at.

### T-1 · Delete the dead, keep the live
Remove `research/electron-source/ComfyUI-Scruple` and the superseded
Kohya Dockerfile/start.sh — **preserving `scruple_safetensors_hook.py`**,
which must move somewhere live first. Remove the `forge` appId or give it
a registry entry. Stop describing `external/scruple-nodes` as a Scruple
integration.
*Gate: nothing imports what was deleted; the hook still resolves.*

### T-2 · Tests before changes
Studio has none. Every task below alters provenance capture, and altering
provenance capture with no tests is how §5 got broken in the first place.
Minimum: the proxy's `/prompt` intercept, graph capture shape, the
safetensors hook's payload, and the Kohya route's HMAC verification.
*Gate: suites run in `tests.yml`. This is the task most likely to be
skipped and the one that makes the rest safe.*

### T-3 · Baseline from the container manifest (§3, §4)
`container_manifest.py` already computes the tamper surface. Wire it to
`POST /v2/baseline` at container start and pod start, and to
`POST /v2/baseline/rebaseline` when the manifest hash changes between
runs — which for a rebuilt image is exactly the §4 event.
*Gate: every Studio leaf carries a `baseline_ref`; a rebuilt image
produces a rebaseline leaf with a non-null `witness_leaf_id`.*

This is the task that makes Studio the first integration to satisfy §3
and §4, and it is mostly wiring. The measurement already exists.

### T-4 · Make the Kohya witness route witness
Give it a real leaf via `POST /v2/witness` with `kind: model_write`.
Resolve the principal question its own comment raises: the pod HMAC
authenticates the hook, not the human. Options are (a) exchange the pod
HMAC for a scoped session key at pod start via `/v2/session/handoff`, or
(b) have the route look up the session's owner and witness on their
behalf. **(a) is cleaner and matches the canon auth model; (b) is less
work.** Recommend (a).
*Gate: the route returns `witnessed:true` only when a leaf exists, and
`false` otherwise — never `ok:true` over nothing.*

### T-5 · Collect the training provenance the schema already provides for
Populate `dataset_merkle`, `base_model_hash`, hyperparameters and
lineage from the Kohya config at run start rather than at checkpoint
write. Carry them into the leaf under `witness.training`.
*Gate: a real training run produces a `training_runs` row with dataset
and base-model fields populated, and a leaf that commits to them.*

The `parent_run_id` / `lineage_type` / `parent_checkpoint_hash` columns
describe a fine-tune-of-a-fine-tune lineage. Worth confirming that is
still wanted before building capture for it.

### T-6 · Close the silent degrades
Container-manifest failure stops being non-fatal now that the manifest is
the baseline. The `ModelPatcher_{id()}` fallback is replaced by an
explicit "unidentified model" marker — an honest gap beats a fabricated
identifier that looks like data.
*Gate: no leaf carries an empty `machine_manifest_hash` or a fabricated
model name.*

### T-7 · Modalities through `/v2/mark` (§9)
Studio produces images and video — the media where §9.1 C2PA and §9.2
watermarking both genuinely apply, unlike the CAD trio. This is where the
watermark endpoint gets its first real caller, and where Studio becomes
the first integration to have ever attached a content credential.
*Gate: an image generated in Studio carries a C2PA manifest and a
timestamp watermark, and the leaf records the selection per §9.5.*
*Blocked on: the Signer CVM being powered back on.*

### T-8 · Per-session HMAC (§tenancy)
Replace the global `SCRUPLE_APPS_WITNESS_SECRET` with a per-session
secret issued at pod start. Not a Standard clause — a launch blocker.
*Gate: a secret captured from one pod cannot witness for another user.*

---

## 5. Decisions needed before T-3

1. **Is the container manifest the tamper surface, or part of it?**
   §3 says the baseline covers "the code, configuration, and attested
   compute environment." The container manifest covers the image. It does
   not cover the ComfyUI workflow's own custom nodes if those are mounted
   rather than baked. If they can be mounted, the baseline is incomplete
   and needs to say so.

2. **Does a rebuilt image force a re-baseline, or a new baseline?**
   §4 says a transition is a leaf linked to the prior baseline by hash.
   Modal rebuilds may be frequent. If every rebuild is a §4 event the
   chain fills with them — which may be correct and honest, or may mean
   the tamper surface is drawn at the wrong granularity.

3. **Whose baseline is it?** For desktop plugins the tenant is the
   customer. In Studio, Scruple operates the environment. A baseline that
   Scruple both produces and attests is weaker evidence than one attested
   against a customer-controlled surface, and §12.2's note on what the
   customer-compute chain does and does not prove is directly relevant.
   **This is a Standard question, not an implementation one.**

4. **T-5 lineage** — confirm fine-tune-of-fine-tune lineage is still
   wanted before building capture for those four columns.

---

## 6. Out of scope

- The Signer CVM stays down; T-7 is specified but not runnable.
- No desktop shell is touched.
- `external/scruple-nodes` keeps syncing its upstream fork; it is not a
  Scruple integration and does not get one.
- The Standard question in §5.3 above is raised, not answered.
