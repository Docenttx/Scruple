# Scruple × Kohya-ss RunPod image

Custom container image for RunPod pods that host Kohya-ss GUI with the
Scruple provenance hook installed.

**This directory's `Dockerfile`/`start.sh` build path is superseded.**
Production runs `ashleykza/kohya:latest` via a RunPod `dockerStartCmd`
that curls `scruple_safetensors_hook.py` from
`https://scruple.stooges.ai/pod-hooks/kohya_safetensors_hook.py`
(served from `public/pod-hooks/` in this repo) — see
`docs/canon/WO-05-studio-comfyui-kohya.md` §2. The Dockerfile below is
kept buildable but is not what production pods run.

## Files

- `Dockerfile` — builds from `runpod/pytorch:2.4.0` + clones Kohya-ss
  v25.0.3 + installs `sitecustomize.py` (the safetensors hook).
  Superseded for production use (see above); kept for reference and in
  case this build path is revived.
- `scruple_safetensors_hook.py` — the Python hook that intercepts every
  `safetensors.torch.save_file` call and POSTs the checkpoint to
  scruple-web, which **records** it (`training_runs` +
  `app_kohya_progress`) but does **not** sign a witness leaf from this
  path — `POST /api/apps/kohya/witness` reports `witnessed: false`.
  See `docs/canon/STUDIO_P1-P8_GRADE.md` (Path B — Kohya). This file
  must stay byte-identical to `public/pod-hooks/kohya_safetensors_hook.py`
  — that copy is the one production actually fetches and wins on any
  disagreement.
- `start.sh` — launches Kohya-ss headless on 0.0.0.0:7860

## Build + push

```bash
cd /data/scruple-web/research/scruple-kohya-image
docker build -t <your-registry>/scruple-kohya:v1 .
docker push <your-registry>/scruple-kohya:v1
```

Registries to consider:
- Docker Hub (`docker.io/<user>/scruple-kohya`)
- GHCR (`ghcr.io/<org>/scruple-kohya`)
- RunPod's own registry (`registry.runpod.io/…`)

## Register RunPod template

1. RunPod Console → Templates → New Template
2. Container Image: `<your-registry>/scruple-kohya:v1`
3. Container Disk: 40 GB
4. Volume Disk: 40 GB, Mount Path: `/workspace`
5. Expose HTTP Port: `7860`
6. Container Start Command: (leave empty — CMD handles it)
7. Save. Copy the template ID.

## Wire into scruple-web

Add to `.env.local`:

```
RUNPOD_API_KEY=<your-api-key>
RUNPOD_KOHYA_TEMPLATE_ID=<template-id-from-step-above>
NEXT_PUBLIC_KOHYA_ENABLED=1
NEXT_PUBLIC_KOHYA_WS_ORIGIN=wss://scruple-kohya-ws.stooges.ai
```

**`SCRUPLE_APPS_WITNESS_SECRET` is retired (WO-12) — do not set it.** It was
one HMAC key injected into every pod, so any customer running `env` held the
credential that authenticated every other customer's traffic
(`docs/canon/STUDIO_P1-P8_GRADE.md`, Path B, P3). Pods are now given
`SCRUPLE_SESSION_TOKEN`, their own session's token, and nothing in the codebase
writes the global value into a pod any more. If the variable is still set in a
deployment, `/api/apps/kohya/witness` will still accept a declaration signed
with it and will log an error naming it every time; unset it to close the path.

Cloudflare tunnel entry (add to `/etc/cloudflared/config.yml`):

```yaml
- hostname: scruple-kohya-ws.stooges.ai
  service: http://localhost:8191
  originRequest:
    httpHostHeader: scruple-kohya-ws.stooges.ai
```

Then:

```bash
sudo -n TUNNEL_ORIGIN_CERT=/home/ubuntu/.cloudflared/cert.pem \
  cloudflared tunnel route dns 4267d8dd-903f-4d0f-a5a4-478f55129b12 \
  scruple-kohya-ws.stooges.ai
sudo systemctl restart cloudflared
pm2 start /data/scruple-web/scripts/kohya-ws-proxy.mjs --name kohya-ws-proxy
pm2 save
```

## Smoke

1. Navigate to `https://scruple.stooges.ai/apps/kohya`
2. Wait for pod boot (shell shows "Warming up Kohya on RunPod")
3. Once Kohya loads, configure a small LoRA training with any base
   model available on the pod's disk
4. Start training. Every checkpoint save should trigger a POST to
   `/api/apps/kohya/witness` — watch `pm2 logs kohya-ws-proxy` for
   confirmation
5. Check the scruple-web project workspace — a `training_runs` row
   should appear with `model_hash`/`header_hash` populated (recorded,
   not witnessed — see the note in "Files" above)

## Debugging

- **Pod won't start**: check RunPod pod logs — the `start.sh` echoes
  every SCRUPLE_* env; confirm they're all set.
- **Hook not firing**: `SCRUPLE_WITNESS_URL` env missing on the pod →
  scruple-web's `runpod-session.ts` failed to pass it. Check the pod
  spec that was submitted.
- **Hook errors but training completes**: `pm2 logs scruple-web` for
  the received POST body; check the HMAC signature against the session's
  `SCRUPLE_SESSION_TOKEN` (WO-12). A 401 with no other detail is deliberate —
  the route does not distinguish "no such session" from "bad signature",
  because doing so hands an unauthenticated caller a session-enumeration
  oracle.
- **`credential: "global-deprecated"` in the response**: the deployment still
  has `SCRUPLE_APPS_WITNESS_SECRET` set and something is still signing with it.
  Unset it.
