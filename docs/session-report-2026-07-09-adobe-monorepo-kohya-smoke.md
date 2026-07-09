# Session report — Adobe monorepo + Kohya E2E attempt
## 2026-07-09 (overnight autonomous run)

## Summary

Two threads this session:

- **WO-ADOBE**: refactored scruple-photoshop into a proper monorepo,
  added Illustrator + InDesign UXP plugins, generalized server witness
  endpoint. **Complete + committed.** Blocked only on user having a
  Windows/Mac machine with UDT to actually load-and-test.

- **WO-KOHYA P7 (E2E smoke)**: RunPod credit now live. All server-side
  infrastructure verified (API key auth, template creation, pod spawn
  API call, Cloudflare tunnel, WS sidecar). **Pod spawns but Kohya's
  Gradio process doesn't stay up** — repeated container restart loop
  (uptimeInSeconds keeps going negative). Root-cause hypothesis + fix
  path noted below.

## WO-ADOBE — what shipped

### New monorepo at `/data/scruple-adobe/`

```
lib/
  scruple-common.js       # auth, disk cache, HMAC + witness POST,
                          # heartbeat, panel event bus
  panel-boilerplate.js    # palette UI wiring
  shared-index.html       # panel HTML — identical across apps
shared-styles/panel.css   # crimson + cyan brand
build.sh                  # copies shared files into each apps/<host>/

apps/
  photoshop/    manifest.json + main.js  (save event = 'save')
  illustrator/  manifest.json + main.js  (event = 'documentSaved')
  indesign/     manifest.json + main.js  (event = 'afterSave')
```

Each `apps/<host>/` is a self-contained UXP plugin ready to sideload
via UDT. Adding Adobe app N+1 is `manifest.json` + ~30-line `main.js`.

### Server side (in scruple-web, feature/pivot)

- `app/api/scruple/witness/adobe/route.ts` — one endpoint, `host_app`
  field discriminates. Per-host content-type map. Auto-creates
  "Adobe <host> Documents" catch-all project if user has none.
- `app/auth/adobe/page.tsx` — handshake page. Mints per-host API key,
  drops into `handoff_slots` for plugin polling.
- `app/apps/adobe/page.tsx` — dashboard. Install cards per app (with
  heartbeat "Installed" / "Not seen" badge), coming-soon rows for
  Premiere + Lightroom, install steps.

### What's testable without Adobe installed

Everything server-side compiles + runs. The plugin JS is documentation-
driven (Adobe UXP developer.adobe.com docs are public). What we can't
verify without a Mac/Windows machine + UDT:

- Whether `documentSaved` (Illustrator) and `afterSave` (InDesign) event
  names are the exact strings modern UXP emits. If not, the fix is a
  one-line edit to `apps/<host>/main.js`.
- Whether `require('illustrator').app` and `require('indesign').app`
  namespaces work with UXP as I've assumed. Same fix pattern.

## WO-KOHYA P7 — E2E attempt

### What verified end-to-end
1. **RunPod API auth** ✅
2. **Template creation via REST v1** ✅ (id `7lxi6lu86v`)
3. **Pod spawn API** ✅ (both community spot + secure on-demand
   accepted the request and returned pod ids)
4. **Cloudflare tunnel** ✅ (`scruple-kohya-ws.stooges.ai` DNS + ingress
   live)
5. **WS sidecar under pm2** ✅ (:8191 listening)
6. **Hook static file** ✅ (curl `https://scruple.stooges.ai/pod-hooks/
   kohya_safetensors_hook.py` returns 200)
7. **All env vars wired** into `.env.local`

### What didn't work
- **Community spot 4090**: `Bid by user` → stuck waiting for spot
  availability. Terminated after 5 min.
- **Secure on-demand 4090** ($0.69/hr): pod entered RUNNING, but the
  `ashleykza/kohya:latest` container's Gradio never came up on 7860.
  `runtime.uptimeInSeconds` went from -8 to -10 across polls (negative
  and getting worse) — indicates the container was being restarted
  repeatedly. Proxy URL returned 404 for 4+ minutes.

### Hypothesis

Our template overrides `dockerStartCmd` with a bash one-liner that
curls the hook + starts Kohya. The `ashleykza/kohya:latest` image likely
has its own entrypoint or init script that expects to run first (mount
volumes, start SSH, set up conda env, etc.). Our override skips that,
so Kohya crashes on missing setup, RunPod restarts the container,
loop.

### Fix path (for next session)

Two approaches:

**A. Use ashleykza's default init + install hook later.**
Drop the `dockerStartCmd` override entirely. Let ashleykza's image
boot Kohya however it wants. Inject the hook via a **post-boot**
mechanism:
   - Add an env var like `SCRUPLE_HOOK_URL` and a small
     `/etc/rc.local` snippet that curls + installs sitecustomize.py
     BEFORE Python starts.
   - Or spawn a sidecar process from `/workspace/kohya_ss/gui.sh`
     with an `sudo` prefix.
   - Cleanest: fork ashleykza's image, add our hook as a Dockerfile
     COPY, publish to our registry. Small delta on a solid base.

**B. Use a simpler public Kohya image.**
   - `sukumin/kohya_ss:v2` (10 GB, updated 2026-05) might have a
     simpler init.
   - Or fork the bmaltais/kohya_ss official Docker (if they publish
     one — the DHub search didn't find it) or build from scratch on
     the RunPod PyTorch 2.8 base.

### Cost this session
- Community spot pod: terminated before any GPU billing
- Secure pod #1: ran ~5 min at $0.69/hr = **~$0.06**
- Template creation: free
- **Total spend: under $0.10**

Both terminated. No pod currently running.

## Follow-up priority for next session

1. Fix the Kohya container-init issue. Fork approach A is probably
   cleanest — it's ~10 lines added to a Dockerfile that FROMs
   `ashleykza/kohya:latest`.
2. Retest E2E: spawn pod, wait for Gradio, load Kohya in browser,
   configure a small SDXL LoRA training (5 images, 100 steps, rank 4),
   verify safetensors save fires the hook → POST hits our
   `/api/apps/kohya/witness` → `app_kohya_progress` row appears.
3. Then the Photoshop/Illustrator/InDesign E2E on your Windows/Mac
   machine.

## Commits

```
fcc8a3c WO-ADOBE: /apps/adobe dashboard page
22a9ae0 WO-ADOBE: generalized /api/scruple/witness/adobe + /auth/adobe handshake
```

In `/data/scruple-adobe/`:
```
1dd5095 Scruple for Adobe CC — monorepo v0.2 (PS + AI + ID)
```

## Environment left running

- pm2: `kohya-ws-proxy` on :8191 (running, no live pod to talk to)
- Cloudflare tunnel: `scruple-kohya-ws.stooges.ai` live (routes to :8191)
- `.env.local`: has real `RUNPOD_API_KEY`, `RUNPOD_KOHYA_TEMPLATE_ID`
  (7lxi6lu86v), `SCRUPLE_APPS_WITNESS_SECRET`, `NEXT_PUBLIC_KOHYA_ENABLED=1`
- Template `7lxi6lu86v` on RunPod — needs `dockerStartCmd` fix per
  Hypothesis above
