# Smoke results — 2026-06-22 overnight (post-deploy)

User authorized Modal deploy + smoke. Results below.

## Deploy

`modal deploy modal/scruple_runner.py` succeeded after two iterations:

1. First attempt failed on `git clone --branch v1.7.9` for VHS — that's
   the pypi version, not a real git tag. Same for `v2.5.22` on seedvr2.
   Fix: drop `--branch` so we clone main with `--depth=1`.

2. Second attempt built but `_get_json('/object_info')` returned 0
   seedvr/VHS nodes. Root cause via `diagnose_startup`:
   - **`libGL.so.1: cannot open shared object file`** — Easy-Use imports
     cv2 at module load. Fix: `apt_install("libgl1", "libglib2.0-0",
     "ffmpeg")` (matches canvas_app.py).
   - **`infer_schema(func): Parameter q has unsupported type torch.Tensor`** —
     diffusers ≥0.36 broke torch 2.4.0 custom_op schema inference at
     import time (attention_dispatch.py:739). seedvr2 imports diffusers
     transitively, so a broken diffusers import broke its node
     registration. Fix: pinned `diffusers>=0.33.1,<0.34`.

3. Third deploy: clean. 203s build time.

## Node registration verified

`modal.Function.from_name('scruple-runner','list_nodes')`:

| Substring filter | Count |
|---|---|
| `seedvr` | 4 — `SeedVR2VideoUpscaler`, `SeedVR2LoadDiTModel`, `SeedVR2LoadVAEModel`, `SeedVR2TorchCompileSettings` |
| `vhs` (case-insensitive) | 40 |
| `easy` | 206 |

No regressions on Easy-Use; VHS + seedvr2 added.

## Workflow execution smoke (#1)

Minimal workflow: `EmptyImage(64×64, red) → SaveImage`. Smallest
workflow that exercises the full pipeline (no model load required).

```json
{
  "1": {"class_type":"EmptyImage","inputs":{"width":64,"height":64,"batch_size":1,"color":16711680}},
  "2": {"class_type":"SaveImage","inputs":{"images":["1",0],"filename_prefix":"smoke_numpy"}}
}
```

Result:

```
ok: true
prompt_id: 731fc629-ecd8-4abf-8715-77fdf0e92657
content_type: image/png
output_filename: smoke_numpy_00001_.png
output_kind: image
duration_ms: 22046
gpu: T4
image_bytes: 1671 (1.6KB)
attestation: null  (model_fingerprints empty — no model loaded)
```

PNG bytes returned + valid base64; image-bytes hash reproducible
client-side. End-to-end Modal-runner → /prompt → /view → bytes-back
pipeline works on the redeployed image.

## What was NOT run (out of session-budget)

- **Image gen smoke (SD 1.5)** — requires a checkpoint in the Modal
  volume. The volume currently has 0 model files. A `fetch_to_volume`
  call to pull SD 1.5 (~4GB) is a 5-10 min operation; deferred.
- **Video gen smoke (AnimateDiff)** — same; needs motion module + SD 1.5.
- **LoRA training smoke** — needs longer-running on-demand GPU window
  and a tiny training dataset, ~5-10 min.
- **Canvas-on-Modal deploy (`canvas_app.py`)** — would need a second
  `modal deploy` then verify endpoint URLs. Not run.
- **Witness server pm2 restart** — needed to pick up v2.2 patch.
  No iteration yet exercises the v2.2 path; safe to defer.

## Operator next steps to finish the smoke matrix

```
cd /data/scruple-web

# Pull SD 1.5 to volume (one-time, ~3 min):
python3 -c "
import modal
fn = modal.Function.from_name('scruple-runner', 'fetch_to_volume')
print(fn.remote(
  'https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
  'checkpoints/v1-5-pruned-emaonly.safetensors'))
"

# Then a real txt2img smoke:
python3 -c "
import modal
wf = {
  '1': {'class_type':'CheckpointLoaderSimple','inputs':{'ckpt_name':'v1-5-pruned-emaonly.safetensors'}},
  '2': {'class_type':'CLIPTextEncode','inputs':{'text':'a red apple','clip':['1',1]}},
  '3': {'class_type':'CLIPTextEncode','inputs':{'text':'','clip':['1',1]}},
  '4': {'class_type':'EmptyLatentImage','inputs':{'width':256,'height':256,'batch_size':1}},
  '5': {'class_type':'KSampler','inputs':{'seed':42,'steps':12,'cfg':7,'sampler_name':'euler','scheduler':'normal','denoise':1,'model':['1',0],'positive':['2',0],'negative':['3',0],'latent_image':['4',0]}},
  '6': {'class_type':'VAEDecode','inputs':{'samples':['5',0],'vae':['1',2]}},
  '7': {'class_type':'SaveImage','inputs':{'images':['6',0],'filename_prefix':'smoke_img_sd15'}},
}
fn = modal.Function.from_name('scruple-runner', 'run_workflow')
r = fn.remote(wf, None)
print('ok:', r.get('ok'), 'dur_ms:', r.get('duration_ms'), 'size:', len(r.get('image_bytes_b64','')))
"

# Then deploy canvas app + the v2 proxy path can be smoked via /canvas in browser.
python3 -m modal deploy modal/canvas_app.py
pm2 restart scruple-witness  # picks up v2.2 patch
pm2 start scripts/canvas-ws-proxy.mjs --name canvas-ws-proxy
pm2 restart scruple-web
```
