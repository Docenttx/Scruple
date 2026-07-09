# Scruple × Kohya-ss RunPod image

Custom container image for RunPod pods that host Kohya-ss GUI with the
Scruple provenance hook installed.

## Files

- `Dockerfile` — builds from `runpod/pytorch:2.4.0` + clones Kohya-ss
  v25.0.3 + installs `sitecustomize.py` (the safetensors hook)
- `scruple_safetensors_hook.py` — the Python hook that intercepts every
  `safetensors.torch.save_file` call and POSTs a witnessed leaf to
  scruple-web
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
SCRUPLE_APPS_WITNESS_SECRET=<random-32-char-hex>
```

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
5. Check the scruple-web project workspace — a training iteration row
   should appear with a leaf hash

## Debugging

- **Pod won't start**: check RunPod pod logs — the `start.sh` echoes
  every SCRUPLE_* env; confirm they're all set.
- **Hook not firing**: `SCRUPLE_WITNESS_URL` env missing on the pod →
  scruple-web's `runpod-session.ts` failed to pass it. Check the pod
  spec that was submitted.
- **Hook errors but training completes**: `pm2 logs scruple-web` for
  the received POST body; check HMAC signature against
  `SCRUPLE_APPS_WITNESS_SECRET`.
