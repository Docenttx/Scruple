# Session report — WO-KOHYA + WO-PHOTOSHOP overnight execution
## 2026-07-06 (autonomous overnight run)

## Summary

Two work orders executed to their blockers in a single autonomous session:

- **WO-KOHYA** (Kohya as Studio app 3, backed by RunPod) — **Phases 0–4
  landed** (research + compute backend abstraction + session mint +
  proxy + WS bridge + custom RunPod image with monkey-patched
  safetensors hook + server-side witness endpoint). **Phase 7 blocked**
  on user's RunPod API key.

- **WO-PHOTOSHOP** (Fusion-pattern UXP plugin for Adobe Photoshop) —
  **Phases 0–4 landed** (Fusion source studied, UXP plugin skeleton,
  auth handshake port, save-hook capture, palette UI, server-side
  witness endpoint). **Phases 6–7 blocked** on Adobe dev account +
  Photoshop subscription.

## WO-KOHYA — what shipped

### P0: Research (agent af924eab)
Research agent confirmed:
- REST v1 (`https://rest.runpod.io/v1/`) is the current API — GraphQL
  legacy. Auth: `Bearer $RUNPOD_API_KEY`.
- RunPod's proxy URL pattern: `https://<podId>-<port>.proxy.runpod.net`.
  Constructed client-side. Service **must bind 0.0.0.0**.
- Kohya-ss GUI default port `7860`. Launcher: `python kohya_gui.py
  --listen 0.0.0.0 --server_port 7860 --headless --do_not_share --noverify`.
- Cleanest witness insertion: monkey-patch
  `safetensors.torch.save_file` (single call site in `networks/
  lora.py::LoRANetwork.save_weights`). No callback registry exists.
- Community 4090 ~$0.34/hr, secure A100 ~$1.89/hr, community H100
  ~$2.49/hr. Per-second billing, no minimum.
- Community "Cloudflare tunnel" is not a Kohya feature — skip it.
  Ship on `*.proxy.runpod.net` from day one.

### P1: Compute-backend abstraction
- `lib/apps/session-backends.ts` — `SessionBackend` interface
  (`spawnEndpoint` / `terminateEndpoint` / `pricePerHourCents`) +
  registry.
- `lib/apps/backends/modal-session.ts` — wraps existing Canvas Modal
  URL resolution. Non-breaking for Canvas.
- `lib/apps/backends/runpod-session.ts` — REST v1 `POST /v1/pods`,
  `GET /v1/pods/:id`, `DELETE /v1/pods/:id`. Waits for `RUNNING` +
  `publicIp` + port mapping, returns the proxy URL. Passes pod env
  (`SCRUPLE_USER_ID`, `SCRUPLE_SESSION_ID`, `SCRUPLE_WITNESS_URL`,
  `SCRUPLE_WITNESS_SECRET`) so the in-pod monkey-patch can auth
  its witness POSTs.
- `lib/apps/runpod-machines.ts` — 4 RunPod machines (4090 community,
  RTX 6000 Ada community, A100 80GB secure, H100 80GB community).
- `lib/apps/registry.ts` — Studio app catalog. Kohya row enabled
  when `RUNPOD_API_KEY` is set.

### P2: Studio app registry + Kohya tab + migration
- Migration `029_app_sessions.sql` — `app_sessions` (generic per-user
  per-app registry) + `app_kohya_progress` (lightweight mirror for the
  monkey-patch POSTs).
- `lib/apps/session.ts` — `mintAppSession` / `getActiveAppSession` /
  `revokeAppSession` / `proxyUrlForAppSession`. Delegates to backend
  adapter. Revokes prior active per `(user, app)`.
- `app/apps/kohya/page.tsx` — get-or-mint session, iframe
  `/kohya-proxy/<sid>`, error cards for `no_runpod_key` / `no_template`
  / `spawn_timeout`.
- `app/api/apps/[appId]/session/route.ts` — POST idempotent, DELETE
  by sessionId query.
- `components/ViewToggle.tsx` — Kohya pill (visible when
  `NEXT_PUBLIC_KOHYA_ENABLED=1`).

### P3: Proxy + WS bridge
- `app/kohya-proxy/[sessionId]/[[...path]]/route.ts` — mirrors canvas
  proxy: reads `app_sessions`, cold-start shell for RunPod boot,
  injects `<base>` + fetch/XHR/WS shim on root HTML for Gradio.
- `scripts/kohya-ws-proxy.mjs` — sidecar on `:8191` that reads
  `app_sessions`, pipes WS frames, 30s keepalive ping (learned from
  canvas), reserved-close-code guard.
- Cloudflare tunnel entry planned for `scruple-kohya-ws.stooges.ai`
  (level-2 subdomain for Universal SSL — same lesson from canvas).

### P4: Provenance capture
- `research/scruple-kohya-image/Dockerfile` — RunPod PyTorch base
  + Kohya-ss v25.0.3 + installs `sitecustomize.py`.
- `research/scruple-kohya-image/scruple_safetensors_hook.py` — the
  monkey-patch. Wraps `safetensors.torch.save_file`, hashes the file,
  extracts the header, POSTs to `/api/apps/kohya/witness` in a
  background thread with HMAC signature.
- `research/scruple-kohya-image/start.sh` — headless launch.
- `research/scruple-kohya-image/README.md` — build/push + template
  registration + Cloudflare tunnel entry + smoke.
- `app/api/apps/kohya/witness/route.ts` — verifies HMAC (constant-
  time), looks up session, upserts `app_kohya_progress` mirror.
  Witness-server integration marked as Phase 4-B TODO.

### Blocked (P5 partial, P6, P7)
- **P5 (Stripe backend bifurcation)** — abstraction is in place
  (`pricePerHourCents` per backend), but wiring into the existing
  Stripe pre-auth flow requires the RunPod key to test end-to-end.
- **P6 (Kohya launch UI)** — deferred; the Gradio UI already provides
  the training config surface. Progress pill is only useful once
  witness POSTs actually fire.
- **P7 (E2E smoke)** — needs `RUNPOD_API_KEY` + `RUNPOD_KOHYA_TEMPLATE_ID`
  in `.env.local`, custom image built + pushed + template registered.

## WO-PHOTOSHOP — what shipped

### Phase 0: Fusion source study
- Read `/data/scruple-fusion/ScrupleFusion.py`. Ported these patterns:
  disk-cached API key, `session=latest` handoff fallback, heartbeat,
  always-visible tracking pill, `_do_witness` shape, palette layout
  (project list scrollable + recent edits + lock buttons).

### Phase 1: UXP plugin skeleton (`/data/scruple-photoshop/`)
New sibling repo alongside `/data/scruple-fusion/`.
- `manifest.json` — UXP v5, min PS 24.0, permissions (launchProcess,
  network all, localFileSystem plugin).
- `index.html` — panel shell with auth-panel / active-panel switch.
- `styles/panel.css` — crimson wordmark + cyan accent tag (same
  brand vocabulary as the web Studio sidebar).
- Icons dir seeded (placeholders — swap for real assets when signing).

### Phase 2: Auth handshake (Fusion pattern port)
`main.js`:
- `readCachedApiKey()` / `writeCachedApiKey()` — disk cache via
  `uxp.storage.localFileSystem.getDataFolder`.
- `signIn()` — mint session UUID, `uxp.shell.openExternal` browser to
  `/auth/photoshop?session=<uuid>&product=photoshop`, poll `/api/scruple/
  handoff` with `session=<uuid>` AND `session=latest` for 5 min.
- Heartbeat every 60s to `/api/scruple/handoff/heartbeat`.

### Phase 3: Save-hook provenance capture
`main.js`:
- `action.addNotificationListener(['save'], …)` — Photoshop's save
  event.
- Reads the saved file via `uxp.storage.localFileSystem.getEntryWithUrl`,
  sha256s the bytes via `crypto.subtle.digest`, builds a payload with
  file_size + doc dimensions + layer count + color mode.
- POSTs to `/api/scruple/witness/photoshop`.
- Emits `scruple:witness:success` / `witness:error` events for the
  panel UI.

Server: `app/api/scruple/witness/photoshop/route.ts` — Bearer API
key auth (`product='photoshop'` scope), resolves target project (or
auto-creates "Photoshop Documents" catch-all), inserts iterations row,
calls witness server (:5799) for leaf hash + HMAC, bumps
`project.iteration_count`, returns `leaf_hash` + `edit_count`.

### Phase 4: Palette UI
`panel.js` — full UI wiring:
- Tracking pill (green/grey Fusion pattern)
- Active project card
- Projects list (top 10, click to switch active)
- Recent edits (last 20, leaf hash prefix)
- Lock buttons wired to existing `/api/lock/{checkpoint,local,chain}`
  and `/api/scruple/c2pa/sign`
- Toast for success/error

`README.md` + `install-dev.md` document the unsigned-dev-install flow
via UXP Developer Tool.

### Blocked (P5, P6, P7)
- **P5 (file-tree helpers)** — nice-to-have; path-based project
  binding, Drive picker, deep-link back to scruple-web. Deferred.
- **P6 (packaging + signing)** — needs Adobe Developer Console app
  registration to sign `.ccx`. Can self-sign `.zxp` for internal
  distribution once we have an Adobe dev account.
- **P7 (E2E)** — needs Adobe CC dev account + Photoshop 24.0+
  subscription to load in UDT and test.

## Files touched

**scruple-web** (feature/pivot branch, 4 new commits):
- `lib/apps/session-backends.ts` (new)
- `lib/apps/backends/{modal,runpod}-session.ts` (new)
- `lib/apps/backends/index.ts` (new — barrel)
- `lib/apps/runpod-machines.ts` (new)
- `lib/apps/registry.ts` (new)
- `lib/apps/session.ts` (new)
- `lib/db/migrations/029_app_sessions.sql` (new)
- `app/apps/kohya/page.tsx` (new)
- `app/api/apps/[appId]/session/route.ts` (new)
- `app/api/apps/kohya/witness/route.ts` (new)
- `app/api/scruple/witness/photoshop/route.ts` (new)
- `app/kohya-proxy/[sessionId]/[[...path]]/route.ts` (new)
- `scripts/kohya-ws-proxy.mjs` (new)
- `components/ViewToggle.tsx` (edit — Kohya pill)
- `research/scruple-kohya-image/` (new — Dockerfile + hook + start.sh + README)
- `.env.local` (env placeholders)
- `docs/wo/2026-07-06-kohya-runpod-app.md` (WO)
- `docs/wo/2026-07-06-scruple-photoshop.md` (WO)

**scruple-photoshop** (new sibling repo, 1 initial commit):
- `manifest.json` (UXP v5)
- `index.html`
- `main.js` (auth + save hook)
- `panel.js` (palette UI)
- `styles/panel.css`
- `icons/` (placeholders)
- `README.md`
- `install-dev.md`

## Commits (this session)

```
b7a9c96 WO-PHOTOSHOP P3: /api/scruple/witness/photoshop endpoint
e044989 WO-KOHYA P4: provenance capture (custom RunPod image + witness endpoint)
3bf62c9 WO-KOHYA P2+P3: session mint + Kohya tab + HTTP proxy + WS bridge
f22a8e0 WO-KOHYA P1: compute-backend abstraction (Modal + RunPod adapters)
e35805a docs: WO-KOHYA (RunPod-backed Studio app 3) + WO-PHOTOSHOP (UXP plugin)
```

Plus in `/data/scruple-photoshop/`:
```
83edde7 Scruple for Photoshop — WO-PHOTOSHOP Phases 0-4
```

## To resume when the blockers clear

### If user provides RUNPOD_API_KEY

1. Set `.env.local`:
   ```
   RUNPOD_API_KEY=<key>
   SCRUPLE_APPS_WITNESS_SECRET=$(openssl rand -hex 32)
   ```
2. Build the custom image:
   ```
   cd /data/scruple-web/research/scruple-kohya-image
   docker build -t <registry>/scruple-kohya:v1 .
   docker push <registry>/scruple-kohya:v1
   ```
3. Register RunPod template (see `research/scruple-kohya-image/README.md`).
   Copy the template ID.
4. Set:
   ```
   RUNPOD_KOHYA_TEMPLATE_ID=<template-id>
   NEXT_PUBLIC_KOHYA_ENABLED=1
   NEXT_PUBLIC_KOHYA_WS_ORIGIN=wss://scruple-kohya-ws.stooges.ai
   ```
5. Add Cloudflare tunnel ingress (level-2 subdomain per canvas
   lesson):
   ```
   sudo -n TUNNEL_ORIGIN_CERT=/home/ubuntu/.cloudflared/cert.pem \
     cloudflared tunnel route dns 4267d8dd-903f-4d0f-a5a4-478f55129b12 \
     scruple-kohya-ws.stooges.ai
   ```
   Edit `/etc/cloudflared/config.yml` to add the hostname entry
   pointing at `http://localhost:8191`. Restart cloudflared.
6. `pm2 start /data/scruple-web/scripts/kohya-ws-proxy.mjs --name kohya-ws-proxy && pm2 save`
7. Restart scruple-web. Navigate to `https://scruple.stooges.ai/apps/kohya`.
8. Complete P5 (Stripe backend bifurcation for RunPod pods) and P4-B
   (full witness-server integration in `/api/apps/kohya/witness`).

### If user provides Adobe dev account

1. Install UXP Developer Tool via Adobe CC.
2. Open UDT → Add Plugin → `/data/scruple-photoshop/manifest.json`.
3. Load into Photoshop 24.0+.
4. Sign in via the panel; save a PSD.
5. Verify `iterations` row appears in scruple-web.
6. Complete P5 (nice-to-haves) and P6 (packaging).
