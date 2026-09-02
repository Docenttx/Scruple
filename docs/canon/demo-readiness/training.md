# Training provenance — demo readiness

_Survey, 2026-09-02. Read-only archaeology; nothing was built, deployed or spent._
**Scope:** model training end to end, both candidate paths — Kohya (RunPod) and
ComfyUI/Modal. Generation flows and C2PA/watermarking are surveyed elsewhere.
**Binds:** `KOHYA_REPLACEMENT.md`, `MODEL_WRITE_HOOK.md`,
`STUDIO_P1-P8_GRADE.md` (Path B), `PLACEMENT_AND_SURFACES.md` §4.1/§7.2.

---

## 0. The matrix

Cells are **WORKS (cited)** / **BROKEN (cited)** / **NEVER BUILT** / **UNVERIFIED**.
"Sealed" means a registered deployment seal under `lib/seal/registry.ts` +
migration 046.

| | runs today | checkpoint captured | leaf written | training fields present | sealed |
|---|---|---|---|---|---|
| **Kohya via RunPod (GUI)** — the shipping default | **WORKS (cited)**, with an age caveat — GUI reachability proven once, 2026-07-09; `app_sessions` has 0 rows, so never exercised since, and never through a training job | **UNVERIFIED** — hook never observed firing; 0 rows | **NEVER BUILT (cited)** — refusal by design, never `true` in any commit | **BROKEN (cited)** — 4 of ~12 columns written, no recipe commitment | **NEVER BUILT** |
| **Kohya via job-API** | **BROKEN (cited)** — no image, no template, no caller | **UNVERIFIED** — code exists, never executed | **UNVERIFIED** — designed to; never run | **WORKS (cited)** — except `header_hash` | **NEVER BUILT** |
| **ComfyUI / Modal training** | **NEVER BUILT** in the current canvas | **NEVER BUILT** — checkpoint does not cross the gate | **NEVER BUILT** | **NEVER BUILT** | **NEVER BUILT** |

One historical row, because it is the answer to "training worked before" and it
is not any of the three above:

| | ran | checkpoint captured | leaf written | training fields present | sealed |
|---|---|---|---|---|---|
| **Modal `diffusers+peft`, 2026-07-05** — retired, source deleted | **WORKS (cited)** | **WORKS (cited)**, by hand | **WORKS (cited)**, pre-L2 | **BROKEN (cited)** — no recipe, no `header_hash` | n/a (pre-seal era) |

---

## 1. "Training worked before" — what it actually was

**It was one event, and it was none of the three paths above.**

On 2026-07-05 a rank-4 SDXL LoRA was trained on Modal T4 by a standalone
`diffusers+peft` function, `modal/scruple_trainer.py`. It produced an 11,778,336-byte
safetensors, `sha256 3141eb75…`, which was uploaded to Drive, given a witness
leaf, and triple-anchored as `SCR_DB433994`.

Citations:

- `docs/session-report-2026-07-06-scruple-canvas-integration.md:22-48` — the run,
  the hashes, the RVN/IPFS/Arweave anchors, the receipt id.
- `data/scruple.db` → `iterations` id=170, project 181: `witnessed=1`,
  `witness_id=wit_0b6b3c0a8c42fe0c`, `witness_signature=573b2384…`,
  `output_kind='training'`, `output_bytes=11778336`. This row is real.
- `data/scruple.db` → `training_runs` id=2: `dataset_merkle=8689db16…`,
  `base_model_hash=31e35c80…`, `model_hash=3141eb75…`, `source='diffusers+peft'`.
- `modal/__pycache__/scruple_trainer.cpython-310.pyc`, mtime 2026-07-05 06:13 —
  the only on-disk trace; the source is absent from the working tree and exists
  in exactly one commit, `ec5931d`, on branch `feature/pivot`, which is **not an
  ancestor of HEAD**.

Four qualifications, all from the founder's own contemporaneous notes:

1. **The weights are worthless.** `session-report-2026-07-06:52-55` — "Loss went
   NaN — fp16 mixed-precision blew up during MSE. The safetensors is technically
   random noise decorated with SDXL structure. **Capture pipeline** is proven;
   **actual LoRA quality** is not."
2. **The capture was hand-driven, not an integration.** Same report, lines 63-75,
   documents the manual three-step choreography (`POST /api/witness` → `UPDATE`
   the iterations row → `POST /api/lock/chain`) required because "direct DB
   inserts into scruple-web's DB are invisible to the witness server." Line 233:
   "project 181 direct DB inserts, no git commits." The `training_runs` row has
   `created_at == started_at == completed_at` to the second — a single INSERT,
   not an observed run.
3. **It was not Kohya and not ComfyUI.** Same report, line 57: "Went through a
   standalone Modal function, not ComfyUI's TrainLoraNode … doesn't exercise the
   ComfyUI capture route. That was the original ask; deferred."
4. **It is a pre-L2 artifact and should be dated as one.** `witness_signature` is
   64 hex characters — an HMAC-SHA256 seal from the `:5799` witness server, which
   `docs/sessions/2026-05-22.md` T5 names as "HMAC witness, symmetric." The
   absence of a modern Ed25519 leaf signature on it is an era difference, not a
   defect. `data/scruple.db` is at migration 028; HEAD carries 47.

### The precise answer to the coordinator's question

**No Kohya checkpoint has ever carried a witness leaf. The Kohya capture has
never even reached the database row.**

Both halves matter, and the second is the stronger finding:

- `app_kohya_progress`: **0 rows**. `checkpoints`: **0 rows**. `app_sessions`:
  **0 rows**. `training_runs` has **no row with `source='kohya_ss'`**.
- `app/api/apps/kohya/witness/route.ts` has never in its history returned
  `witnessed: true`. At its birth (`7d2fa98`) the response had no `witnessed`
  field at all, only `// TODO Phase 4-B: POST to witness server (:5799)`. The
  field was *introduced already hardcoded false* by `89cfafd` (WO-11a, 2026-08-30),
  and `test/v2/kohya-honesty.test.ts:177` now fails if anyone writes `witnessed: true`.
- The safetensors save hook has never been observed firing:
  `docs/canon/WO-05-studio-comfyui-kohya.md:137-141` — "### 3.5 The Kohya hook has
  never been observed firing … Everything downstream of it is therefore untested
  in production conditions."

So for Kohya the remediation is **not** a regression fix. Nothing regressed;
nothing ever ran. That is a materially different and larger job than "find what
broke," and it is worth saying plainly even though it is unwelcome.

### What the 2026-07-09 "Kohya E2E WIN" commit actually proved

`4d073f0` claims "the full pipeline now works end-to-end: browser →
`/kohya-proxy/<sid>` (200 OK) → scruple-web HTTP proxy → `https://<podId>-3001.proxy.runpod.net`
→ `ashleykza/kohya:latest` pod." That is **HTTP and WebSocket reachability of a
Gradio GUI**. `docs/session-report-2026-07-09-adobe-monorepo-kohya-smoke.md:47-59`
is explicit under "What's NOT yet verified (needs a real training run — deferred)",
and line 108 records total spend for the night as **~$0.12** — roughly one
4090-minute. `docs/wo/2026-07-06-kohya-runpod-app.md:135-141` still has all four
Phase 7 acceptance boxes unchecked at HEAD, including "Real training run through
Studio … see safetensors delivered to Drive with witnessed leaf" and "Full receipt
for the training run."

### The July artifact's signed manifest is right and its prose is wrong

This is the highest-priority finding in the survey, because it is already
outside the building and because it is the exact failure mode that reads as
tampering to an auditor.

**The cryptography is correct.** In
`docs/provenance-bundles/bundle-29e9a40e1d43/iterations/training-181/`, the
signed sidecar binds the right bytes:
`manifest.json:23,50` and `verification-report.json:13,16` all carry the LoRA's
`3141eb75…`, and `manifest.json:41` correctly labels `31e35c80…` as the base
model `sd_xl_base_1.0.safetensors`.

**The human-readable wrappers are not.** Three of them swap the two hashes and
present the *base model's* SHA-256 as the trained artifact's:

- `…/training-181/README.md:7` — "**Trained artifact SHA-256:** `31e35c80…`"
- `…/training-181/README.md:41` — inside "How a verifier uses this":
  `sha256sum "$MODEL"` / `# should equal: 31e35c80…`. **A reviewer who follows
  our own verification instructions gets a mismatch**, because the file hashes
  to `3141eb75…`.
- `docs/wo/2026-07-12-c2pa-mcc-wg/00-membership-application.md:33` — tells the
  C2PA MCC working group "Whole-file SHA-256 `31e35c80…`" for the LoRA.

`…/training-181/NOTES.md:33-45` shows how it happened: the bundle's author
noticed the collision ("`training_runs.base_model_hash` ==
`iterations.model_fingerprints_hash`"), recorded that "the task brief says this
value is the **LoRA output** content hash," and resolved it correctly in the
manifest and incorrectly in the prose. The DB is unambiguous:
`base_model_path='sd_xl_base_1.0.safetensors'` sits next to `base_model_hash=31e35c80…`,
and `model_hash=3141eb75…` matches the session report's "Output: 11.8MB
safetensors, sha256 `3141eb75…`" and `output_bytes=11778336`.

**Separately, the same filing misattributes the trainer.** It says the LoRA was
"trained via Kohya-ss under the `diffusers+peft` trainer family." The DB says
`source='diffusers+peft'` with `kohya_version` empty; the session report says a
standalone Modal function. It was not Kohya. The claim is also inside the
*signed* manifest — `manifest.json:38` and `verification-report.json:136` carry
`"trainer_family": "kohya-ss / diffusers+peft"` — emitted by
`scripts/puffjuly12/12-emit-lora-sidecar.py:199`, where the string is hardcoded.
Correcting that one requires re-signing.
2. **`3871c60` (2026-07-12) describes a manual `UPDATE` as a capture fix.** Its
   message says it completed the Phase 4-B TODO "that had left
   `training_runs.model_hash` + `header_hash` unpopulated from every real Kohya
   training run." There were no real Kohya training runs. Its own next paragraph
   admits it backfilled project 181 by hand and that `header_hash` stayed NULL
   because "the pod is long gone" — project 181 was a Modal container, not a pod.

---

## 2. The Kohya path today, after the recent churn

### 2.1 What a user actually gets when they start a Kohya session

`SCRUPLE_KOHYA_SURFACE` is **not set in `.env.local`**, so
`lib/apps/runpod-machines.ts:50` returns `'gui'`. That selects
`RUNPOD_KOHYA_TEMPLATE_ID` (set, `7lxi…`) and port 3001
(`RUNPOD_KOHYA_GRADIO_PORT`), spawns `ashleykza/kohya:latest`, and
`app/apps/kohya/page.tsx:94-99` iframes it through `/kohya-proxy/<sessionId>`.

**The capture component is not in this path at all.** `resolveKohyaPlacement()`
→ `unattested-client` is real, but it is a property of
`services/scruple-capture/kohya/index.ts`, which is never started by the GUI
flow. Nothing refuses; the GUI simply serves, and the honest labels ride in the
pod env: `podEnvFor()` sets `SCRUPLE_PLACEMENT=unattested-client` and
`SCRUPLE_CAN_WITNESS=0` (`lib/apps/backends/runpod-session.ts:210-215`).

So the answer to "what happens today if a user starts a Kohya session" is: **a
Gradio training launcher appears, the user can train, and if the in-pod hook
fires the checkpoint is recorded as a self-declaration with `witnessed: false`.**
Nothing refuses and nothing is witnessed. Whether the hook fires at all is the
`UNVERIFIED` cell — it has never been observed (`WO-05 §3.5`).

One live operational note: **`SCRUPLE_APPS_WITNESS_SECRET` is still set in
`.env.local`.** WO-12 removed the code that *distributes* it, but this
deployment still holds the value, so `authenticate()`'s deprecated branch
(`app/api/apps/kohya/witness/route.ts:119-120`) is still reachable. The removal
condition is one branch plus re-pointing `test/v2/kohya-honesty.test.ts`.

### 2.2 The job API is built and unreferenced

Confirmed by grep: the only references to `app/api/apps/kohya/jobs` anywhere in
the repo are **its own source, its own test file, and two doc lines**. No
component, no page, no client, no fetch call. The tenant surface it was built to
replace is still the one shipping.

Three independent things each block it, and all three are configuration or
build, not code:

1. `SCRUPLE_KOHYA_SURFACE` unset → `gui` (`lib/apps/runpod-machines.ts:50`).
   The default is deliberate — `runpod-machines.ts:37-44` argues that defaulting
   to the better tier would let a deployment *claim* `server-library` while
   running the GUI image.
2. `RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID` unset. `runpod-session.ts:246-253` **throws
   rather than falling back**, by design.
3. `research/scruple-kohya-image/Dockerfile.jobapi` **has never been built**.
   `KOHYA_REPLACEMENT.md:800-812` names this as enforcement obligation 1 and 2,
   both `needs_probe`: "the image has not been built and nothing has verified
   what a running container actually exposes."

This is the good news in the survey. The job API is the only path in the estate
whose *design* reaches `server-library` and whose response carries a derived,
non-declared tier (`jobs/route.ts:252-276`). It is one image build and two env
vars from being exercisable. It has simply never been exercised.

### 2.3 `header_hash` — confirmed, and slightly better than reported

`MODEL_WRITE_HOOK.md` §4.2's finding **holds**:

- `lib/leaf/registry.yaml` — no `id: header_hash`. Confirmed by grep; the
  registry's field ids are enumerated at lines 222-523 and it is not among them.
  The only `header_hash` in the estate's type surface is `lib/types.ts:88`, a key
  *inside* a `model_fingerprints` entry — the base model the run loaded, not the
  checkpoint it wrote.
- `app/api/v2/witness/route.ts` — no `header_hash` in the Zod body (lines
  104-175). Zod strips unknown keys silently, so a client sending it loses it
  without an error.
- Therefore it is **not in the MAC preimage** and is uncovered.
  `ModelWriteOutcome.header_hash_covered` is `False` and
  `test_header_hash_rides_on_the_wire_and_is_not_covered_by_the_mac` pins it.

One correction to the doc: the legacy route now **does** persist it —
`app/api/apps/kohya/witness/route.ts:275,309` writes `body.header_hash` into
`training_runs.header_hash`, and `checkpoints.header_hash` has an index
(`idx_ckpt_header_hash`). So the structural fingerprint has a durable home
**only on the path whose ceiling is `witnessed: false`**, exactly as
`MODEL_WRITE_HOOK.md` §4.2 predicted. In the one training run that exists,
`training_runs.header_hash` is empty.

### 2.4 What the recent WOs did and did not change

Reconciled, because the recent work reads as contradictory:

| WO | Changed | Did **not** change |
|---|---|---|
| WO-11a (`89cfafd`) | Introduced `witnessed: false` + reason on the legacy route | Nothing was witnessed before it either |
| WO-11b/12 (`1f0ef22`) | Retired the global secret's *distribution*; per-session token; `placement` in the response | The value is still in `.env.local`; the ceiling is unchanged |
| WO-19 (`1afd328`) | Built the job API, the 44-param whitelist, the argv builder, `job-runner.ts`, `Dockerfile.jobapi` | Wired none of it to a caller; built no image |
| WO-20 | `model.write` contract, two trainer implementations, `examples/vendor-training/` | The registry, the Zod body and the three preimages — `header_hash` still homeless |

**Net: the Kohya path's evidence ceiling is exactly where it was in July 2026.
What changed is that it now says so accurately.** That is real progress on
honesty and zero progress on capability.

---

## 3. ComfyUI / Modal training

**As a distinct flow in the current canvas: it does not exist.** Saying so
plainly rather than manufacturing a gap.

- `modal/canvas_app.py` — the image the canvas runs — installs ComfyUI v0.18.5,
  ComfyUI-Easy-Use, VideoHelperSuite and seedvr2. **No training node pack.**
  Lines 116-121 record that the `scruple_nodes` pack (including
  `ScrupleTrainingTerminal`) was deliberately removed: "target the desktop
  Electron Studio at localhost:5742 — dead code in scruple-web."
- `modal/scruple_runner.py` — the older runner — **does** carry a training
  branch: `TRAIN_CLASSES = {"TrainLoraNode", "SaveLoRA", "LoraSave"}` at line 496,
  `is_training` detection, a `models/loras` snapshot/diff, and
  `output_kind: "checkpoint"` at line 596. Its image installs no training pack
  either.
- **Structurally, the canvas gate cannot see a checkpoint.**
  `lib/canvas/egress.ts:35-40` defines `BYTE_EGRESS` as four `GET` patterns —
  `/view`, `/userdata/…`, `/api/assets/<uuid>/content`,
  `/experiment/models/preview/…`. Capture happens on byte egress through those
  routes. `docs/sessions/2026-05-22.md:23-27` is the definitive statement of the
  problem: "`SaveLoRA` / `TrainLoraNode` / `CheckpointSave` are terminal nodes
  that write a `.safetensors` straight to disk and **register no `/view`
  output**." A checkpoint never crosses the gate. It would trip the
  unenumerated-egress tripwire only if it *did*, and it does not.
- `lib/canvas/witness.ts:778` will classify a `.safetensors` as `'checkpoint'` —
  but only for bytes that already reached it, which by the above they cannot.

**Historically it did work, once, and better than Kohya ever has.**
`docs/sessions/2026-05-22.md:38-40`: "CAP-6 proven in 39s (cold) / 21–24s (warm)
per LoRA checkpoint on A10G. Three checkpoints (sd15lora_b/c/d, ranks 4/8/16)
witnessed end-to-end on project 13." Commit `25433e3`. Note the era: that was
the v1 leaf scheme (`leaf_hash == output_hash`), on `feature/pivot`, and **those
three checkpoints are not in `data/scruple.db`** — project 13 exists with 0
iterations. The evidence for CAP-6 is the session narrative and the commit, not
a surviving row.

---

## 4. What a training receipt should contain, and what we can produce

Field shapes from `packages/scruple-host-sdk/scruple_host_sdk/model_write.py`,
`packages/scruple-api/scruple_api/model_write.py` and
`docs/canon/MODEL_WRITE_HOOK.md` §4.

| Commitment | Leaf field | Kohya GUI (today) | Kohya job-API (if built) |
|---|---|---|---|
| **Dataset root hash** | `input_hash` | **not available** — the GUI never tells us the dataset path; nothing hashes it | **producible** — `dataset_root_hash()` is implemented (`scruple_api/model_write.py:290`) and `/v2/witness` accepts `inputs`/`input_hash` |
| **Hyperparameters / recipe** | `workflow_hash` | **not available** — the GUI's argv is built inside the pod; only 4 columns are written back, and none of them is a commitment | **produced** — the 44-param whitelist *is* the recipe; `training_recipe()` + `hash_training_recipe()` handle the float problem; `/v2/witness` accepts `training` and hashes it via `hashGraphOrTraining` |
| **Base-model fingerprint** | `model_fingerprints_hash` | **not available** from the hook's body | **producible** — `fingerprint_model_file()` exists; `/v2/witness` accepts `model_fingerprints`/`model_fingerprints_hash` |
| **Checkpoint content hash** | `content_hash` | **produced** — this is the one thing the hook sends | **produced** — `observe_checkpoint()` streams SHA-256, sends no bytes |
| **`header_hash`** (structural fingerprint) | *no field exists* | **produced and stored, but only in `training_runs`** — off-leaf, un-MACed | **produced, rides on the wire as `capture.header_hash`, still uncovered** |
| **Machine manifest** | `machine_manifest_hash` | not available | not available — no manifest for a RunPod pod |
| **Attestation** | — | none | none — `attestation: 'none'`, so `passthrough` is the ceiling even at `server-library` |

Summary: **one of five core commitments is produced today; four are producible
on the job-API path; one (`header_hash`) has no home on any leaf regardless.**

Contrary to `MODEL_WRITE_HOOK.md` §8 item 4 and `KOHYA_REPLACEMENT.md`'s
closing note, `/v2/witness` **does** already accept `kind: 'model_write'`,
`training`, `inputs`/`input_hash` and `model_fingerprints`/`model_fingerprints_hash`
(`app/api/v2/witness/route.ts:106,121-122,134-144`). That gap appears to have
closed since those docs were written. `header_hash` is the only field genuinely
missing.

---

## 5. The demo question

### What a credible training receipt would look like today

**None, from any shipping path.** A receipt showing a checkpoint's content hash
with `witnessed: false` is not a training receipt; it is a log line. Shown to the
EU AI Office it would invite exactly the question we could not answer — *what
data was this trained on, and how do you know?* — because `input_hash` is the
field that answers it and no shipping path produces it.

The 2026-07-05 receipt `SCR_DB433994` is the only training artifact with a real
signature and a real anchor, and it **should not be demonstrated as-is**. Three
reasons, in order:

1. Its provenance record was typed in by hand, not captured. That is the exact
   property an auditor tests for.
2. It commits to no recipe (`workflow_hash` empty) and no dataset on the leaf
   (`input_hash` empty) — the two fields the regulatory interest is actually about.
3. Its README hands a reviewer a `sha256sum` check that fails, and its signed
   manifest says "kohya-ss," which is false. Correcting both is a prerequisite
   to showing it to anyone — and the manifest half needs a re-sign.

Its dataset merkle (`8689db16…`) and base-model hash (`31e35c80…`) *are* in
`training_runs` — so the underlying facts exist; they simply never reached a leaf.

### The shortest credible path to one

The job-API path is one build and two env vars from being exercisable, and it is
the only path whose derived tier is `server-library`. In dependency order:

1. **Build `research/scruple-kohya-image/Dockerfile.jobapi`** and register the
   RunPod template. Sets `RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID`; discharges enforcement
   obligations 1 and 2, which are `needs_probe` today purely because nothing has
   ever run.
2. **Set `SCRUPLE_KOHYA_SURFACE=job-api`.** No code change; the spawn already
   refuses to downgrade silently.
3. **Give the job API a caller.** It has none. This is the smallest genuinely
   missing piece of product and the only one that is not configuration.
4. **Run one small job** — the smoke report's own estimate was 5 images, 100
   steps, rank 4, ~$0.05 — and confirm `job-runner.ts` emits a `model_write` leaf
   through `/v2/witness` with `training`, `inputs` and `model_fingerprints`
   populated. This is the step that has never been taken, on any path, ever.
5. **Then** decide `header_hash`. It is a leaf-scheme bump (registry entry, Zod
   field, column, three `component_preimage` implementations plus the shared
   vector file) and it should not gate steps 1-4 — a leaf carrying dataset,
   recipe and base-model commitments is already far stronger than anything we
   have, and `header_hash` can ride uncovered on the wire meanwhile, which is
   what the SDK already does and already reports.

Steps 1-4 would produce the first training receipt in the project's history that
was *captured* rather than *asserted*. That, and not the July artifact, is the
thing worth showing.

### Two things to say out loud before any demo is scheduled

- **A training receipt is the most interesting artifact we could show and the
  one we are furthest from.** The regulatory interest is training-data
  provenance; `input_hash` is that field; no shipping path populates it.
- **Nothing here is a regression.** The Kohya path has never captured a
  checkpoint or written a leaf. Framing it as "it worked before" would lead to
  a debugging exercise against a path that has no working state to return to.

---

## 6. Open items, ranked

| # | Item | Why it ranks here |
|---|---|---|
| 1 | Bundle README + MCC filing give the **base model's** hash as the trained artifact's; the README's own `sha256sum` verification step therefore fails | Already outside the building; a failing verification instruction reads as tampering. Prose-only fix — the signed manifest is correct |
| 1b | MCC filing + **signed** manifest say "Kohya-ss"; it was Modal `diffusers+peft` | Same audience; the manifest half needs a re-sign, so it is slower than 1 |
| 2 | The job API has no caller | The single smallest missing piece of product on the only path that reaches `server-library` |
| 3 | `Dockerfile.jobapi` never built; obligations 1-2 unprobed | Blocks everything downstream; cheap |
| 4 | `header_hash` has no registry field, no Zod field, no preimage slot | Confirmed; leaf-scheme bump; should not gate #2/#3 |
| 5 | `SCRUPLE_APPS_WITNESS_SECRET` still set in `.env.local` | Config change, no code change; closes WO-12's remainder |
| 6 | `session-report-2026-07-09…:82-88` cites four shas that do not exist in this repo | Anyone verifying that report by sha finds nothing |
| 7 | No sharded/directory-checkpoint answer (`MODEL_WRITE_HOOK.md` §5) | Product decision; will bite the first real fine-tune |
