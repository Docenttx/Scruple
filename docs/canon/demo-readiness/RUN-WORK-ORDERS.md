# Run work orders — one flow at a time, to green

_2026-09-02. Executes `PRIORITIES.md` item 1. Founder-authorised **$25**._

## The rule that shapes every WO below

**One flow at a time. Run → diagnose → fix → RERUN → memory → next.**

A flow is not finished when it has been *attempted*. It is finished when it runs
**100% end to end** and the evidence is verified **by side effect, not by report**
— the row in the database, the leaf on the witness, the manifest read back — never
the runner's own success message.

**Do not move to the next flow while the current one is partial.** A half-working
flow costs more than an unstarted one, because it looks finished in a summary.

**Write a memory between flows.** These runs are long and compaction is likely;
the memory is what survives it. Update
`project_scruple_demo_readiness_2026_09_02.md` in place — status per flow, spend
so far, and the exact next step.

## Two rules that will otherwise cost real money and real damage

**1. The witness rule is INVERTED for these runs.**
Test suites must point `WITNESS_SERVER_URL` at `http://127.0.0.1:1` — a prior
session polluted the production audit log. **But these are real runs, and they
must reach the real witness on `:5799` or they produce no leaf.** Know which you
are doing before every command. Real project ids only; the synthetic-prefix guard
(`server.js:554`) will refuse `tenant:`/`baseline:`.

**2. Spend is metered.** Log the actual cost of each run in the memory as you go.
Report actuals, never estimates. Stop at **$25** and ask.

## Setup (once, free)

Dev server on `:3001` with `NODE_ENV=development` and `SCRUPLE_DEV_AUTH=1`; mint a
session with `scripts/scrupel.mjs login`; export `SCRUPLE_SESSION`. Verify with
`scrupel health` and `scrupel projects` **before** spending anything. `TMPDIR` is
already `/mnt/corpus/scruple-web-scratch`.

---

## WO-31 · txt2img — the baseline, and the regression check

**Why first:** the only flow with a defensible existing record (iterations
166-169, all five hashes). If it breaks, tonight's changes broke it, and
everything after is unsafe.

**Run** a single txt2img through `scruple-run.ts`.

**Green means:** a leaf on the real witness, `witnessed=1`, and **all five hashes
present** — `content_hash`, `input_hash`, `workflow_hash`,
`model_fingerprints_hash`, `machine_manifest_hash`. Plus **the container manifest
stored**, which no product door has ever passed. Verified by SQL, not by the
runner's output.

**Watch for:** `input_hash` must still be present — `inputs: []` is *true* of
txt2img, and WO-27's decline logic must not have turned that into a decline.
Compare the new row against iteration 166 field by field; **strictly more, never
less.**

---

## WO-32 · img2vid — the flow that really ran

**Why second:** it demonstrably worked (LTX 2b, T4, 90.3s, real fingerprints,
bound input frame), so a failure is a regression rather than a build.

**Green means:** everything in WO-31, plus `output_kind='video'`, the **correct
extension and MIME** (the old door stored WebM as `.png`), the **input frame bound
into `input_hash`**, and the `Range`/206 path exercised — the proxy gated on
`upstreamRes.ok`, which is true for a 206, so scrubbing minted rows over
fragments.

**Then sign it.** MP4/MOV C2PA is measured-working. Read the manifest back and
confirm `validation_state: Valid`. **This is the first artifact that would carry
both a leaf and a content credential**, which is the demo.

---

## WO-33 · txt2vid — expect a nameable failure

**Why third:** the biggest unknown, and **AnimateDiff is not installed in either
Modal image**. A clean failure here is a *result*, not a defeat.

**Run** a txt2vid graph. **If it cannot execute, stop and say why** — do not build
an image to make it pass. That is a scoping answer for the founder: the
five-modality list is four, and part of WO-27's video work aimed at a flow that
does not run.

**If it does run:** WO-32's bar, plus **WebM must refuse honestly** — it used to
500. A txt2vid producing WebM is the exact case WO-26's refusal was written for.

---

## WO-34 · ComfyUI training — never driven, not never installable

`TrainLoraNode` / `SaveLoRA` are **core** nodes in the pinned v0.18.5.

**Green means:** a checkpoint written, a leaf with `kind='model_write'`, and the
training fields — dataset root hash, hyperparameters, base-model fingerprint.
`header_hash` may be absent; it is a leaf-scheme bump and **must not gate this**.

**If the node does not register**, say so plainly and stop. Same scoping answer.

---

## WO-35 · Kohya training — the first captured receipt

**Founder-gated before spending:** build `Dockerfile.jobapi`, register the RunPod
template, set `RUNPOD_KOHYA_JOBAPI_TEMPLATE_ID`, **`SCRUPLE_CAPTURE_BASELINE_REF`**
(without it `/v2/witness` refuses the leaf outright) and
`SCRUPLE_KOHYA_SURFACE=job-api`. Checklist:
`docs/canon/demo-readiness/training-founder-checklist.md`.

**Green means** the first Kohya checkpoint in the project's history with
`witnessed=1` — proven against a stub tonight, never against a real trainer.

**Do not regress the honesty work.** No path may report a checkpoint as witnessed
unless a leaf exists; `kohya-honesty.test.ts` must stay green.

---

## WO-36 · The demo bundle — only after the flows are green

Assemble one artifact a stranger can verify: the asset, its leaf, its C2PA
manifest, and **a verification instruction that actually verifies.**

**Test it by following it literally.** The existing bundle's `sha256sum` step
names the base model's hash instead of the artifact's — a reviewer doing exactly
what we told them gets a mismatch, which reads as tampering. **That failure mode
is the thing to design against**, and the only way to catch it is to run our own
instructions as a stranger would.
