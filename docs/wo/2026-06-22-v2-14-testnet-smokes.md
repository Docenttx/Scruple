# WO-14 · End-to-end testnet smokes (numpy x3 + image + video + training)

**Scope:** After WO-13 audit green, run a suite of real workflows on the cheap Modal T4 to verify the v2 architecture end-to-end. Test net + dev environment only.

**Reference:** User directive (overnight session): "run end to end smoke tests using the test nets, and try at least 3 workflows using numpy, at least 1 image generation, 1 video generation, and 1 training flow."

## Workflows

### A. Numpy smokes (3 workflows, CPU-light, no model loads)

Goal: validate the proxy capture + witness pipeline without GPU cost.

1. `numpy-add` — single node that np.array([1,2,3]) + np.array([4,5,6]) → returns image-encoded result (or text artifact via dummy Save node)
2. `numpy-conv` — small Conv1d operation over a generated array → image of plot
3. `numpy-fft` — FFT of a generated signal → image of spectrum

Implementation: create three ComfyUI workflows using `ComfyUI-Easy-Use` math nodes or a custom one-off node `scruple-testnet/numpy-smoke.py`. Each workflow ends in `SaveImage` so the existing output capture path triggers.

### B. Image generation (1)

`smoke-img-sd15` — `CheckpointLoaderSimple` (v1-5-pruned-emaonly) → `KSampler` (12 steps, 256x256 to keep T4 fast) → `VAEDecode` → `SaveImage`. Prompt: "a red apple, simple background".

### C. Video generation (1)

`smoke-vid-animatediff` — minimal `AnimateDiffLoader` + 8 frames, 256x256, 12 steps → `VHS_VideoCombine` → mp4. Prompt: "a flag waving".

### D. Training (1)

`smoke-lora-train` — minimal LoRA training: 5 input images (generated in step B or supplied via tiny test fixture), 50 steps, rank 4 LoRA — uses one of the LoRA training nodes available in the catalog (likely VHS or AnimateDiff doesn't cover this; may need ComfyUI-LoRA-Training or kijai/ComfyUI-LoRA-Power-Trainer). Output: a `.safetensors` LoRA file → SaveLoRA node → existing output capture (checkpoint type).

## Modal GPU

- Per user directive: cheap T4. Set `SCRUPLE_MODAL_GPU=T4 SCRUPLE_MODAL_RUN_GPU=T4` for the test.

## Tracking + report

- For each workflow:
  - record `prompt_id`, `run_sequence`, `output_hash`, `leaf_hash`, `machine_manifest_hash`
  - validate audit script returns green
  - log elapsed seconds + Stripe captured cents
- Write `sessions/Smoke/Overnight-2026-06-22/run-<ts>/report.md` with all six runs in a table
- If any fail: capture ComfyUI log via existing `_tail_comfy_log` admin endpoint; diagnose; either fix or document as known-bug

## Caveat — Modal deploy

The WO assumes Modal is already deployed with the new canvas_app + scruple_runner. If `modal deploy` hasn't been run since the WO-1/WO-4/WO-7 changes, the smokes can't run. Document the deploy commands in the report header; if I can't run modal myself (no creds in env or token expired), I stop and ask the user to deploy before resuming smokes.

## Verify (success criteria)

- 6 / 6 workflows complete successfully
- 6 / 6 iterations land in DB with `leaf_scheme='v2.2'`
- 6 / 6 audit-receipts green
- Stripe dashboard shows 6 captured PaymentIntents (or 1 captured for a single session covering all 6)
- WS proxy log shows clean connects/disconnects
- HTTP proxy log shows all 6 workflows captured + all 6 outputs captured
