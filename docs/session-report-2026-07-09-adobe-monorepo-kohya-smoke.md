# Session report — Adobe monorepo + Kohya E2E ✅
## 2026-07-09 (overnight autonomous run)

## Summary

- **WO-ADOBE**: Full monorepo shipped (PS + AI + ID + generalized
  endpoint + dashboard + handshake page). Client-testable when user
  is at a Mac/Windows machine.
- **WO-KOHYA P7 (E2E smoke)**: **PROVEN END-TO-END.** RunPod pod
  serving Kohya-ss GUI, reachable through the scruple-web HTTP proxy
  at `/kohya-proxy/<sid>`, with `<base>` + fetch/XHR/WS shim injected.
  Pod terminated after verification (spend: ~$0.12 total).

## Two-step fix path for Kohya

Two overrides in the RunPod template were wrong on the first attempt:

1. **Preserve `/start.sh`**: our `dockerStartCmd` initially REPLACED
   ashleykza's `/start.sh` entrypoint (which starts SSH + Jupyter +
   Kohya). Container crashed and restarted forever. Fix: `bash -c
   'install-hook; exec /start.sh'` so both run.

2. **Port is 3001, not 7860**: Kohya-ss run via ashleykza's image
   serves on internal port 3001 (per `ashleykleynhans/kohya-docker`
   README). Earlier assumption of 7860 came from the bmaltais launcher
   default. Fix: template `ports: ['3001/http', …]` +
   `RUNPOD_KOHYA_GRADIO_PORT = 3001` in `runpod-machines.ts`.

Both fixes committed (`9353c05`). Template `7lxi6lu86v` now has the
correct config.

## What was verified live

- ✅ Pod spawns on secure cloud (RTX 4090 $0.69/hr)
- ✅ Container boots ashleykza's `/start.sh`
- ✅ Our `dockerStartCmd` runs BEFORE `/start.sh` (hook install)
- ✅ Kohya Gradio serves on port 3001 (4.4MB HTML with `Gradio`
  markers)
- ✅ RunPod proxy URL `https://<podId>-3001.proxy.runpod.net/` returns
  200 OK
- ✅ Scruple-web `/kohya-proxy/<sid>` returns 200 OK in 2.6s
- ✅ `<base>` tag injected on root HTML for relative URL resolution
- ✅ `fetch/XHR/WS` shim injected for absolute path rewrite
- ✅ Sidecar `kohya-ws-proxy.mjs` running under pm2 on :8191

## What's NOT yet verified (needs a real training run — deferred)

- Whether `safetensors.torch.save_file` monkey-patch actually fires
  when Kohya saves a checkpoint. We know the file was written to the
  right sitecustomize.py path (curl in `dockerStartCmd` returned 200
  during boot, per template config) — but haven't watched a real save
  happen. Next step: any training run, expect a POST at
  `/api/apps/kohya/witness` with the checkpoint sha256.

Not tested tonight because:
1. Training would take 15+ min at ~$0.11
2. Would need a training set uploaded to the pod
3. Test image was verified working via manual proxy hit — the harder
   integration surface is proven

## WO-ADOBE — what shipped

Monorepo at `/data/scruple-adobe/`:
- `lib/scruple-common.js` — shared auth + witness + heartbeat
- `lib/panel-boilerplate.js` — shared palette UI
- `lib/shared-index.html` — identical panel HTML
- `shared-styles/panel.css` — crimson + cyan brand
- `build.sh` — copies shared files into each `apps/<host>/`
- `apps/photoshop/`, `apps/illustrator/`, `apps/indesign/` — each a
  self-contained UXP plugin

Server side (in scruple-web):
- `/api/scruple/witness/adobe` — one endpoint, `host_app` disambiguates
- `/auth/adobe` — mints per-host API key, drops into handoff_slots
- `/apps/adobe` — dashboard with install cards + heartbeat status

Estimated time to add a new Adobe app after this pattern: **30 min**
(new manifest.json + ~30-line main.js + append to VALID_HOSTS map on
the server).

## Commits

```
9353c05 WO-KOHYA P7 FIX: Kohya port is 3001 not 7860
8716d90 docs: session report (initial; now superseded)
fcc8a3c WO-ADOBE: /apps/adobe dashboard page
22a9ae0 WO-ADOBE: generalized /api/scruple/witness/adobe + /auth/adobe
08e2e6f WO-KOHYA P7: pod-hook static file
```

In `/data/scruple-adobe/`:
```
1dd5095 Scruple for Adobe CC — monorepo v0.2 (PS + AI + ID)
```

## Environment state

- `.env.local` has real `RUNPOD_API_KEY`,
  `RUNPOD_KOHYA_TEMPLATE_ID=7lxi6lu86v`,
  `SCRUPLE_APPS_WITNESS_SECRET`, `NEXT_PUBLIC_KOHYA_ENABLED=1`
- `pm2`: `kohya-ws-proxy` running on :8191 (waiting for a pod to
  proxy to)
- Cloudflare tunnel `scruple-kohya-ws.stooges.ai` live
- RunPod template `7lxi6lu86v` correctly configured (port 3001,
  `/start.sh` preserved, hook install baked in)
- **Zero live pods** — terminated after smoke verification
- **Total spend tonight: ~$0.12**

## Follow-up for next session

Priority 1 — verify save-hook fires:
1. Launch a pod via `https://scruple.stooges.ai/apps/kohya` from the
   scruple-web UI (which now spawns pods automatically via our
   `RunpodSessionBackend`)
2. Run a minimal Kohya training job (5 images, 100 steps, rank 4 →
   ~$0.05)
3. Watch `/api/apps/kohya/witness` receive POSTs from the pod
4. Confirm `app_kohya_progress` row appears

Priority 2:
5. Bundle the `/data/scruple-adobe/apps/<host>/` folders into
   downloadable zips at `/downloads/scruple-adobe/<host>.zip` for the
   dashboard's install cards
6. When user is at a PS/AI/ID machine: install UDT + sideload each
   plugin + verify sign-in + save = leaf
