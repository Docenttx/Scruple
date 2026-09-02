# ComfyUI-on-Modal generation flows — do they run, and does each write a leaf?

**Survey, 2026-09-02. Read-only. No Modal invocation, no GPU, no spend.**
Everything below is from source, git history, committed artifacts and a
read-only copy of `data/scruple.db`. Where a cell could only be settled by
running a workflow on Modal it says **UNVERIFIED** and names what would
settle it.

Scope: the four generation flows and whether each produces a **witnessed
leaf**. C2PA and watermarking are another survey's rows; they appear here
only where they change how a piece of evidence should be read.

---

## 0. Read the evidence by era, or it will mislead you

Three eras, and a bundle from one of them must not be graded against
another's expectations.

| Era | Dates | What a flow was expected to produce |
|---|---|---|
| **Pre-L2** | ≤ 2026-07-18 | Witness leaf + `scripts/puffjuly12/*` **local-key** ES256 C2PA (`signingCredential.untrusted` is the *expected* code, not a failure). **No watermark, ever.** |
| **L2 merge** | 2026-07-18 → 2026-08-30 | Signing moves behind the Signer CVM / vault. `POST /api/v2/mark` reports `c2pa` and `watermark` as **`outstanding`** — by design, not by breakage (`app/api/v2/mark/route.ts:106-121`). |
| **Now** | 2026-08-30 → | Capture re-platformed onto the capture component (WO-7/WO-10); WO-25 withholds canvas's custody sentence. Signer CVM was brought back up at `01eaab3`. |

**Watermarking has never been wired into Studio for any modality.**
`docs/canon/studio-l2/02-watermark.md:81` — "Skip if `output_kind !== 'image'`
… video and audio are skipped unconditionally"; `:123` — "Video: nothing.
Audio: nothing. No `.py` in `services/watermark/` mentions either." So a
bundle with no watermark is not a regression, it is the whole history.

**Corollary for `docs/provenance-bundles/`:** the folder name implies video
worked, and it did — but the bundle's own `witness/checkpoint.json` has
`leaf_count: 5` and those five leaves are the **five FLUX PNGs**.
`iterations/video-1/`, `audio-1/` and `training-181/` appear in **neither**
the checkpoint **nor** `MANIFEST.sha256` (42 lines, zero matches for
`video|audio|training`). They were added to the directory after the Merkle
root was built. They are real runs; they are not in the tree.

---

## 1. The matrix

Cells are graded on **the leaf**, not on C2PA or watermarking.

| Flow | Runs today? | Leaf written? | Hashes populated | Evidence it worked before |
|---|---|---|---|---|
| **txt2img** | **WORKS (cited)** — three live entry points | **WORKS (cited)** via `/api/runs`; **BROKEN (cited)** via `/api/generate`; **UNVERIFIED** via canvas proxy | see §2 — `/api/runs` is the only path that fills all five | **WORKS (cited).** `data/scruple.db` iterations **166–169** (project 180, 2026-07-05, `witnessed=1`, `leaf_scheme='v2.2'`), each with `generation_jobs` rows `run_prompt='flux-staypuft-iter-N'`. Bundle `iterations/1..5` + `witness/checkpoint.json` |
| **txt2vid** | **UNVERIFIED** — the code path is intact end to end; no txt2vid workflow exists in the repo and no txt2vid run has been made since 2026-05-22 | **UNVERIFIED**, and **BROKEN (cited)** for the LTX/`SaveAnimatedWEBP` shape — see §3.1 | `.webm`: all five reachable via `/api/runs`. `.webp`: misclassified as an image at every layer | **WORKS (cited).** `ad824da` (2026-05-22): "LTX-Video **txt2vid** (512x512x49 → WebM, **witnessed**)". `docs/sessions/2026-05-22.md:96`: "Verified E2E with all 5 modes (img2img, txt2img, **txt2vid, img2vid**, training). 286/286 audit pass." |
| **vid2vid** | **NEVER BUILT** as a named flow. **img2vid** is the shape that exists and it **WORKS (cited)**. A true video-in workflow would run (VHS is installed) but nothing commits the input video — see §3.2 | **BROKEN (cited)** for input binding: `input_hash` asserts an *empty* input set rather than declining | content ✓ · workflow ✓ · **input ✗ (false empty-set assertion)** · fingerprints/manifest per entry point | **img2vid: WORKS (cited).** `7f97ab9` (2026-07-12 20:26) → `docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/` — LTX-Video 2b, Modal **T4**, `prompt_id 205d18d3-…`, 90,275 ms, real `model-fingerprints.json`. **vid2vid: `git log --all -S"vid2vid"` returns zero hits, ever.** |
| **Model training via ComfyUI** | **NEVER BUILT** as a product flow. A detector exists and is unreachable — see §4 | n/a | n/a | **Partly WORKS (cited), and it is not training.** `25433e3` + `docs/sessions/2026-05-22.md`: "CAP-6 proven in 39s (cold) / 21–24s (warm) per LoRA checkpoint on A10G. Three checkpoints (sd15lora_b/c/d, **ranks 4/8/16**) witnessed end-to-end on project 13." Ranks 4/8/16 are `LoraSave` = **"Extract and Save Lora"** (SVD extraction from a model diff), not `TrainLoraNode`. The **only real LoRA** in the repo (`iterations/training-181/`) declares `"trainer": "diffusers+peft"` |

### The four entry points, because the answer differs by door

| Entry point | Driven by | Status |
|---|---|---|
| `/api/runs` → `lib/runs/execute.ts` | `scripts/scruple-run.ts` (CLI / CC dev pipeline), API-key auth | **The complete path.** Ships inputs to the runner, passes `outputKind` and `modelFingerprints` through to `ingestIteration` |
| `/api/generate` → `/api/generate/status` | `components/CanvasBridge.tsx` (the Queue intercept) | **Lossy.** See §2.2 |
| `app/canvas-proxy/[sessionId]/…` → `lib/canvas/witness.ts` | the Studio canvas iframe | Captures and witnesses, but carries **no model fingerprints** and **no real input hash** |
| `modal.Function.from_name("scruple-runner","run_workflow")` | `scripts/puffjuly12/*.py` | **Bypasses scruple-web entirely.** No `ingestIteration`, no leaf. This is what produced the whole `docs/provenance-bundles/` bundle |

---

## 2. Which of the five hashes each door fills

`content_hash` (= `output_hash`) is `sha256(bytes)` and is populated on every
path. The other four:

| | input_hash | workflow_hash | model_fingerprints_hash | machine_manifest_hash |
|---|---|---|---|---|
| `/api/runs` (sync + async) | ✅ real | ✅ | ✅ | ⚠ DB fallback only |
| `/api/generate?sync=1` | ⚠ empty-set | ✅ | ❌ **null** | ⚠ DB fallback only |
| `/api/generate/status` (**the default**) | ⚠ empty-set | ✅ (from the dispatch log) | ❌ **null** | ⚠ DB fallback only |
| canvas proxy | ⚠ empty-set | ✅ (`graphOf(pending)`) | ❌ **null** | ⚠ per-user Machine row, or null + a warning |
| `run_workflow` direct (puffjuly12) | — | — | — | — (no leaf at all) |

Legend: **⚠ empty-set** — `hashRunInputs` (`lib/leaf/hashes.ts:91-100`) is
*always* non-null; with no `inputs` it hashes `inputs: []`, which affirms
"we enumerated the inputs and there were none." `hashModelFingerprints`
(`:121-124`) makes the honest choice and returns `null` for empty. The
component's own correlator states the rule the ingest path breaks
(`services/scruple-capture/src/correlation.ts:170-176`): "**NULL RATHER THAN
THE HASH OF `[]`** … asserting that about a workflow whose LoadImage points
at a file the tenant put there by hand is a false statement in a signed
record."

### 2.1 What the DB proves about txt2img — and about the T4 regression's fix

Read-only copy of `data/scruple.db` (schema at migration `028`, so it
predates the WO-10 capture tables):

```
project 180 "Stay Puft FLUX cyberpunk — Drive demo (2026-07-05)"
iter 165  wh=44136fa355b3  mfh=NULL   ← 44136fa3… is sha256("{}")
iter 166  wh=32214ac08753  mfh=72ba2726929c
iter 167  wh=4adf01b69168  mfh=72ba2726929c
iter 168  wh=8263819a1d83  mfh=72ba2726929c
iter 169  wh=c41d99c21e71  mfh=72ba2726929c
   all five: witnessed=1, leaf_scheme='v2.2', input_hash set,
             machine_manifest_hash=273df1412170… ( = machines row
             'default-scruple-canvas-v1', i.e. the DB fallback )
```

Iteration 165's `workflow_hash` is the hash of `{}`. That is the T4
regression named in `lib/runs/execute.ts:236-239` — "async runs anchor only
the prompt and the workflow is unwitnessed (T4 regression introduced when
run_workflow moved to generation_jobs)" — caught in the act, and **fixed
between run 1 and run 2 of the same demo**. Model fingerprints start
appearing at the same moment. So `/api/runs` reached full five-hash coverage
on 2026-07-05 and has kept it.

`canvas_pending_iterations` is **empty** and there are **zero** rows with
`output_kind='video'` in this database. The canvas gate has never recorded a
prompt here, and no video has ever been ingested here.

### 2.2 `/api/generate` drops what the runner already computed

`modal/scruple_runner.py:664-676` returns `model_fingerprints`,
`container_machine_manifest` and `container_machine_manifest_hash`.
`lib/compute/modal.ts:118-127` faithfully surfaces all three. Then:

- `app/api/generate/route.ts:239-256` (sync) calls `ingestIteration` with **no
  `outputKind`**, **no `modelFingerprints`**, **no `containerMachineManifestHash`**.
- `app/api/generate/status/route.ts:161-183` (async — the path
  `CanvasBridge.tsx:110` actually uses) does the same.

Two consequences worth naming separately:

1. **`outputKind` defaults to `'image'`** (`lib/iterations/ingest.ts:193`)
   even when the runner said `"output_kind": "video"`. `extFor` then picks the
   stored extension from the content-type: `video/mp4` survives by luck
   (`:187`), **`video/webm` is stored as `.png`** (`:181-189`).
2. **`model_fingerprints_hash` is NULL on every `/api/generate` leaf.**

### 2.3 WO-B1's container manifest is computed and consumed by nobody

`grep -rn "containerMachineManifest"` over `app/ lib/ scripts/ test/` returns
only the *producer* (`lib/compute/modal.ts:125-126`), the *type*
(`lib/compute/backends.ts:67-71`) and the *consumer that is never called with
it* (`lib/iterations/ingest.ts:121-125, 302-312`). **No caller anywhere passes
it** — not `/api/runs`, not `/api/generate`, not canvas. Rung 1 of ingest's
own "resolution ladder (most trusted first)" is unreachable; every Studio leaf
takes rung 2 or 3. `WorkflowStatusDone.result` in `lib/compute/modal.ts:151-171`
does not even declare the field, so the async path could not pass it without a
type change. This is the cheapest single fix in the survey.

---

## 3. Video specifics

### 3.1 `outputKind` is honoured — and then defeated one layer upstream

`lib/canvas/witness.ts:768-779` is correct: declared MIME first, extension
(`/\.(mp4|webm|mov)$/i`) as a last resort. `mimeFromUpstream` is a real
declaration — ComfyUI's `/view` sets Content-Type from
`mimetypes.guess_type(filename)` (`server.py:602-607`), so an `.mp4` arrives
declared `video/mp4` and the canvas path does produce `outputKind='video'`.

**The break is that LTX's writer does not emit a video container.**
`modal/scruple_runner.py:640-641`:

```python
elif lower.endswith(".webp"):
    out_kind, content_type = "image", "image/webp"
```

`VIDEO_EXTS` is `(".mp4",".webm",".gif",".mkv",".mov")` — `.webp` is excluded.
`SaveAnimatedWEBP` writes an **animated** WebP, and both the runner and
`services/scruple-capture/src/mime.ts` (`SaveAnimatedWEBP: 'image/webp'`)
call it an image. That is why `iterations/video-1/meta.json` records
`"modal_filename": "puffjuly12-video_00001_.webp"` and
`"output_container_conversion": "animated webp → h264 mp4 via ffmpeg"`, and
why `09-sign-video.py` has to **overwrite** `output_content_type` to
`video/mp4` after the fact. **The runner never reported that run as video.**
This is not a regression — it has been true since `ad824da` (2026-05-22).

And there is **no committed script for the ffmpeg step**. `08-generate-video.py`
writes the raw output; `09-sign-video.py` assumes `output.mp4` and
`output.webp` already sit side by side. `grep -rn ffmpeg scripts/ modal/ lib/`
finds only the string inside `09`'s meta and the two `apt_install` lines. The
video iteration is **not reproducible from the repo** despite `7f97ab9`'s
message claiming the scripts are re-runnable.

### 3.2 vid2vid: the input video is not committed, and it is worse than "null"

Two independent holes:

1. **The canvas gate never tees an upload.** `lib/canvas/egress.ts:90`
   classifies `POST /upload/image|mask` as `'upload'`, and
   `app/canvas-proxy/…/route.ts:99-101` uses only `isPromptPost` and
   `isByteEgress`. **`'upload'` is classified and then never acted on.** The
   component's `Correlator.recordInputBytes` has no canvas counterpart.
   `witness.ts:806` re-exports `referencedInputNames` and never calls it.
2. **`referencedInputNames` cannot see a video loader anyway.**
   `services/scruple-capture/src/correlation.ts:226-238` matches
   `/^Load(Image|ImageMask|Audio|Video)/`. VideoHelperSuite's loaders are
   `VHS_LoadVideo` / `VHS_LoadVideoPath` — **no match.** So even the
   component's own gate would enumerate zero inputs for a VHS vid2vid graph
   and then hash `inputs: []` as a positive claim.

Same blind spot on the writer side: `writingNodesOf` requires
`/^(Save|Preview)/` (`correlation.ts:208-222`). `SaveAnimatedWEBP` matches;
**`VHS_VideoCombine` — the standard AnimateDiff/vid2vid output node, and the
node both Modal images install — does not.** A VHS video graph therefore has
zero writers, loses `filename-prefix` attribution, and falls back to
`ws-executing` or `most-recent-pending`.

`/api/runs` is the one door that does bind inputs (`RunInputSpec`,
`lib/runs/inputs.ts`, `contentTypeFor` handles `mp4`/`webm`), and
`ad824da`'s message says exactly that was proven: "**img2video (init_image →
WebM, init_image hashed + bound)**".

### 3.3 A large streamed video is not handled the way a PNG is

`app/canvas-proxy/…/route.ts:203-205` — byte-egress is **fully buffered**
before a byte reaches the browser, deliberately ("A captured route is
BUFFERED, never streamed"). Everything else still streams (`:373`). There is
**no size cap and no timeout** on that buffer, and the capture is *awaited*
before delivery, so the whole clip is resident in the Next process while it
is hashed, stored and uploaded to the user's storage provider. For a 1 MB PNG
that is invisible; for a 50 MB clip it is a different product.

**The specific video-only defect: HTTP Range.** `upstreamHeaders`
(`lib/canvas/gate.ts:126-143`) deletes only `host`, `cookie`, `authorization`
and `x-scruple-shared-secret` — **`Range` is forwarded**. ComfyUI serves
`/view` with `web.FileResponse` (`server.py:613-620`), which honours Range and
answers **206 Partial Content**. The proxy gates on `upstreamRes.ok`, and
`Response.ok` is **true for 206**. So a browser `<video>` element seeking
through a proxied clip makes the gate buffer a **fragment**, hash it, and hand
it to `captureBytes` as if it were the artifact — spurious capture rows and,
where a pending prompt is open, spurious iterations. Browsers do not range-
request images, which is exactly why this has never shown up on the PNG path.
**UNVERIFIED by measurement** (that needs a live canvas session); the code
path is unambiguous.

Runner side, same question, different transport: `_get_bytes`
(`scruple_runner.py:408-411`) is one blocking `urllib` read with a 120 s
timeout and no size guard, and the artifact returns **base64-in-JSON** under
`image_bytes_b64` (+33 %) through a Modal FastAPI endpoint. Where that breaks
for a real clip is **UNVERIFIED** — settling it needs one Modal call.

---

## 4. "Model training via ComfyUI" — say it plainly

**It does not exist as a flow, and calling it one would be inventing a gap.**

What exists is a detector with no producer, `modal/scruple_runner.py:496-500`:

```python
TRAIN_CLASSES = {"TrainLoraNode", "SaveLoRA", "LoraSave"}
```

plus a lora-directory snapshot and a `output_kind: "checkpoint"` return
(`:573-600`). Around it:

- `grep -rn "TrainLora\|SaveLoRA\|LoraSave"` over `app/ lib/ components/
  services/ scripts/ examples/` — **zero hits.** Nothing in the repo ever
  builds a training graph.
- All nine workflow JSONs in the repo are inference-only (Flux txt2img and
  LTXV img2vid).
- **The nodes themselves are core, not a missing pack** —
  `comfy_extras/nodes_train.py` (`TrainLoraNode`, `SaveLoRA`) and
  `nodes_lora_extract.py` (`LoraSave`) ship with the pinned ComfyUI v0.18.5.
  So the story is *"never driven"*, not *"never installable"*.
- `ScrupleTrainingTerminal` is dead Electron code and is explicitly excluded
  from the Modal image (`modal/canvas_app.py:116-121`).

What actually ran, and how to describe it honestly:

- **2026-05-22, project 13** — three `.safetensors` witnessed on A10G at
  **ranks 4/8/16**. `LoraSave` is `display_name="Extract and Save Lora"`,
  `category="_for_testing"`, `rank` default 8, input `model_diff` from
  `ModelSubtract`. That is **LoRA extraction from a model diff, not
  training**. It is nonetheless the one time the ComfyUI *checkpoint* capture
  path produced witnessed leaves, and it is the strongest thing in the record.
- **2026-07-05, project 181** — the only real LoRA. `training_runs.source =
  'diffusers+peft'`; the signed manifest says `"trainer": "diffusers+peft"`,
  `"trainer_family": "kohya-ss / diffusers+peft"`. Its leaf carries
  `workflow_hash: null`, `input_hash: null`, `machine_manifest_hash: null` —
  no ComfyUI graph produced it. `modal/scruple_trainer.py` (the standalone
  `diffusers`+`peft` Modal app that made it) exists **only on `feature/pivot`**,
  commit `ec5931d`, and is not an ancestor of HEAD. Its own session report
  (`docs/session-report-2026-07-06-scruple-canvas-integration.md:57-58`) says
  it "**Went through a standalone Modal function, not ComfyUI's
  TrainLoraNode** … doesn't exercise the ComfyUI capture path."
- **Today's canon training path is Kohya on RunPod**, a different backend
  (`lib/apps/registry.ts:55` `backend: 'runpod'` vs canvas's `'modal'`), and
  `app/api/apps/kohya/jobs/route.ts:34-40` says of itself: "IT DOES NOT
  WITNESS ANYTHING."

**If the founder wants "training on ComfyUI via Modal" in the demo, that is a
build, not a repair.** It is a small build — the nodes are core, the runner
detector already handles the no-`/view`-output shape, `/api/runs` already
accepts `outputKind: 'checkpoint'` and `kind: 'training_image'` inputs — but
nothing has ever driven it and there is no fixture to regress against.

---

## 5. What must be married to the new security layer, per flow

Ordered by upstream-ness: the things that block measurement or that a single
line fixes come first.

### Cross-cutting (fix once, all four flows benefit)

1. **Feed the container manifest into the leaf.** The measurement exists
   (`container_manifest.py`), the runner returns it, the ingest ladder wants
   it, and no caller passes it. Until then every Studio leaf's
   `machine_manifest_hash` is a DB descriptor, not what ran — and
   `docs/canon/WO-05-studio-comfyui-kohya.md` §T-3 makes that manifest the
   §3/§4 baseline. Wiring the baseline to a hash nothing binds is the wrong
   order.
2. **Stop asserting an empty input set.** `hashRunInputs` must return `null`
   when the graph references inputs the gate never saw, per the component's own
   rule. Right now three of four doors sign "there were no inputs" for every
   img2vid and vid2vid run.
3. **Make `/api/generate` pass what it already receives** — `outputKind`,
   `modelFingerprints`, `containerMachineManifestHash`. It is the door the
   canvas UI uses, and it is the lossiest one.
4. **Teach the writer/loader tables about video.** `VHS_VideoCombine` (writer)
   and `VHS_LoadVideo` / `VHS_LoadVideoPath` (loader) are installed in both
   Modal images and invisible to `writingNodesOf` / `referencedInputNames`.
   Anything short of that makes every video run a timing guess with no input
   binding.

### txt2img

Closest to demo-ready. Married to the security layer it needs: leaf → 
`POST /v2/mark` with `modalities: ['c2pa','watermark']`, which today returns
both as `outstanding` (`app/api/v2/mark/route.ts:106-121`) until the Signer
CVM branch becomes a real call. `image/png` is in both `C2PA_SIGNABLE` and
`isWatermarkable`, so this is the one flow where the security layer has
nothing structural in its way.

### txt2vid

1. **Pick a container and commit to it.** `.webm` is what the flow historically
   produced (`ad824da`) and is **not** C2PA-signable —
   `lib/v2/capabilities.ts:39-45`, `services/c2pa-signer/formats.py`
   `GENERATE_MIMES`, and `Builder.get_supported_mime_types()` on c2pa 0.36 all
   exclude it. `video/mp4` and `video/quicktime` are signable. A demo that
   emits webm gets a correct 4xx and no credential.
2. **`.webp` must stop being an image.** Either classify animated WebP as video
   in `VIDEO_EXTS`/`NODE_CLASS_MIME`, or make the workflow write
   `SaveVideo`/`VHS_VideoCombine` in mp4 and delete the manual ffmpeg step.
   Today the ffmpeg step is not even in the repo.
3. **Narrow `isWatermarkable`** (`lib/v2/capabilities.ts:54-57`) before the
   demo, not after: `GET /api/v2/capabilities?mime=video/mp4` answers
   *available* and `apply.ts:59` then silently skips — the server offering a
   modality it cannot perform. `docs/canon/studio-l2/04-PLAN.md:280` already
   specifies the fix and says the test asserting current behaviour must change.

### vid2vid (and img2vid)

1. Everything in txt2vid, plus:
2. **Bind the input video.** The `/api/runs` door already does; the canvas door
   cannot until `POST /upload/image` is teed and the VHS loaders are recognised.
   A vid2vid demo run through the canvas would produce a leaf claiming it had
   no inputs — the worst available outcome, because it is a false statement
   rather than a gap.
3. **Range requests.** Before any demo where someone scrubs a video in the
   canvas: either strip `Range` on byte-egress and force a full fetch, or gate
   on `upstreamRes.status === 200` and pass 206 through uncaptured with a
   tripwire entry. As written, seeking mints garbage capture rows.
4. **`digitalSourceType`.** `docs/canon/studio-l2/03-c2pa.md:244` — any
   `init_image`/`source_image`/`control_image` present makes the asset
   `COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA`, and the route never sets it, so
   every img2vid/vid2vid asset would claim pure GenAI provenance. That is a
   false credential on the exact flow this row is about.

### Model training via ComfyUI

Nothing to marry — there is nothing there. Two honest options:

- **Demo the path that exists**: Kohya on RunPod, and close
  `app/api/apps/kohya/witness/route.ts` first, since it returns `ok: true`
  over no leaf (`WO-05` §3.1, and commits `21aebcc` / `89cfafd`).
- **Or build the ComfyUI training flow**, which is genuinely small — core
  nodes, a runner detector that already handles terminal no-output nodes, and
  `/api/runs` already typed for `checkpoint` — but it is a build with no prior
  working state to restore, and it must not be presented as a repair.

---

## 6. Cells I could not settle without invoking Modal

| Question | Why it is open | What would settle it |
|---|---|---|
| Does a txt2vid workflow execute on the **current** Modal image? | VHS + SeedVR2 land in both images at `cf9d18c`/`e6586a2`/`1a850ca` (2026-06-22), but `docs/sessions/2026-06-22-smoke-results.md:71-73` lists the video smoke under "**What was NOT run**" (volume had 0 model files), and no doc since rescheduled it. AnimateDiff itself is **not installed** in either image — it appears only in prose. | One `run_workflow` call with an LTX or VHS graph |
| Does the canvas proxy survive a real video through the buffered gate? | `canvas_pending_iterations` is empty in every DB I can read; no video has ever gone through the canvas leg | One canvas session with a video workflow |
| Where does base64-in-JSON break for a real clip / a real LoRA? | 110 KB clip is the only measured artifact; a 5 s 720p clip is 10–50 MB and a LoRA is 11.8 MB–hundreds of MB | One Modal call at size, watching the endpoint response |
| Does `TrainLoraNode` register and execute on ComfyUI v0.18.5 in the Modal image? | The file exists in the pinned reference tree; nothing has ever queued it | `list_nodes` (already an entrypoint in `scruple_runner.py:990`) then one training graph |
| Is `SCRUPLE_CANVAS_SHARED_SECRET` needed? | It is **absent from `.env.local`**, so `upstreamHeaders` sets no header; `canvas_app.py:170-185` says ComfyUI does not enforce it anyway and the auth shim is a follow-up WO | A canvas session against the deployed Modal URL |

---

## Appendix — the anchor artifact, in full

`docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/`, commit
`7f97ab9`, 2026-07-12 20:26:16 +0000.

```
kind                 img2vid                        (LTXVImgToVideo, 768x512, 25 frames, cfg 3.0, seed 26071231)
model                ltx-video-2b-v0.9.5            + t5xxl_fp16, both fingerprinted (content_hash + header_hash)
input_image_sha256   3a2f0adf…  = iterations/1/output.png  (a txt2img output feeding a video run — real lineage)
workflow_sha256      3198071c…
output               SaveAnimatedWEBP → 396,776 B webp → ffmpeg h264 → 109,788 B mp4
signed               123,558 B, c2pa_reader_state "Valid", Es256, [signingCredential.untrusted]  ← pre-L2, expected
modal_gpu            T4        modal_duration_ms 90,275     modal_prompt_id 205d18d3-b8af-4131-8525-9a0ff0eb886a
```

Produced by `scripts/puffjuly12/08-generate-video.py` calling
`modal.Function.from_name("scruple-runner","run_workflow")` **directly** — so
it proves the *runner* ran video on Modal with fingerprints and a bound input
frame, and it proves nothing about `ingestIteration`, the witness server, or
any HTTP door. There is no leaf for it, in this bundle or in any database I
can read.
