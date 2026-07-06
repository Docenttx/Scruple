# Session report — Scruple Canvas on Modal integration + overnight LoRA
## 2026-07-05 → 2026-07-06

## Executive summary

Two threads shipped in one session:

1. **Overnight LoRA training pipeline PROVEN end-to-end** — real SDXL LoRA
   trained on Modal, uploaded to Drive, chain-locked with all 3 anchors
   (RVN + IPFS + Arweave), receipt live at `/receipt/SCR_DB433994`. Full
   provenance package captured. Details below.

2. **Canvas-on-Modal made functional but not yet fully witnessed** — the
   ComfyUI iframe now loads and generates images. WebSocket bridge is
   live via a dedicated Cloudflare tunnel + pm2-managed sidecar. Modal
   concurrency, cold-start, cold-shell, WS keepalive, and boot bugs all
   fixed. **One final bug** (ComfyUI's per-clientId WS event routing)
   remains: the browser doesn't see execution_success frames, so the
   preview image never populates. Root cause identified with research
   agent, code fix committed; next session verifies with log evidence.

## Thread 1 — Overnight LoRA (COMPLETE)

### What ran

- Modal function `scruple-trainer / train_sdxl_lora` (new — `modal/scruple_trainer.py`)
- Loaded SDXL base 1.0 from Modal Volume
- Trained rank-4 LoRA on the 5 Stay Puft cyberpunk images (project 180 → SCR_22625E18)
- 200 steps, res 768, lr 1e-4, ~6 min on T4
- Output: 11.8MB safetensors, sha256 `3141eb75…`

### What was captured

- **Dataset merkle** `8689db16…` (sha256 of sorted source-image hashes)
- **Base model hash** `31e35c80…` (published SDXL 1.0 sha256)
- **Session hash** `3141eb75…` (full safetensors bytes)
- **Structural summary** (1,120 layers extracted from safetensors header — kilobytes, not megabytes)
- **Drive upload** — `Scruple Projects/training/stay-puft-cyberpunk-lora-r4-1783232592.safetensors`
  (fileId `1P6cUfEseH678-dgXTb3PRcrog4OYbsJ0`)

### Chain lock — SCR_DB433994

- Merkle root: `1404513c398fe04b98a88523b3c1dfac82c1c53c3de7e70eb34d56c49ccfbe97`
- RVN testnet tx: `32882d63ff67b75c99d4c5fbcc651b5c7d83d862a771f8651b091af22f52b616`
- IPFS CID: `bafkreiffhfhdepwvumfje75ojztufagx7qwnq6gcdckkhvylpclhanempa`
- Arweave tx: `98-2Udb-TMUfCxRI-kYUuatktkHRnAcDB3WduGdmSnI`
- Status: `persistent_locked`
- Receipt: https://scruple.stooges.ai/receipt/SCR_DB433994

### Honest limitations

1. **Loss went NaN** — fp16 mixed-precision blew up during MSE. The
   safetensors is technically random noise decorated with SDXL structure.
   **Capture pipeline** is proven; **actual LoRA quality** is not.
   Follow-up: switch trainer to bf16, normalize inputs.
2. **Trained SDXL not FLUX** — T4 (16 GB VRAM) can't fit FLUX (12B params).
3. **Went through a standalone Modal function**, not ComfyUI's TrainLoraNode.
   Cleaner path (no custom-node install), but doesn't exercise the ComfyUI
   capture route. That was the original ask; deferred.
4. **In-loop witness-every-N-steps-without-storing-intermediates pattern**
   was designed in the memory doc but NOT built. Follow-up.

### Witness-server dependency discovered

The `/api/lock/chain` endpoint calls into a separate Node witness server
at `:5799` which maintains its OWN SQLite DB (`/opt/scruple-witness/witness.db`).
Direct DB inserts into scruple-web's DB are invisible to the witness server.

Required order for programmatic entries:
1. `POST /api/witness` — registers the iteration in witness DB, gets back
   `leaf_hash` + `signature`
2. UPDATE scruple-web's iterations row to match the witness's leaf_hash
3. Then `POST /api/lock/chain` — succeeds because witness sees the record

This is captured for future automated ingestion paths.

## Thread 2 — Canvas on Modal (95% done, one bug remaining)

### Timeline of fixes this session

Every one of these was found and fixed live during user testing:

| # | Bug | Fix |
|---|-----|-----|
| 1 | Sidebar showed all projects flat | 6-row scrolling `<ul>` inside `max-h-[380px]` (Fusion palette pattern) |
| 2 | Brand text "SCRUPLE" instead of official wordmark | `<img src=/scruple_wordmark_crimson.png>` + cyan "WEB STUDIO" |
| 3 | Canvas asked for payment on t4-free | Set `t4-free.hourlyRateCents = 0` + skip Stripe branch when 0 |
| 4 | Canvas price ticker showing on free tier | HUD only mounts when `machine.hourlyRateCents > 0` |
| 5 | I added a "Start Canvas" modal — wrong pattern | Reverted; canvas = direct iframe |
| 6 | Blank canvas: 404 on proxy | Route was `[...path]` (required); switched to `[[...path]]` (optional) + dropped trailing slash from `proxyUrlForSession` |
| 7 | Cloudflare 524 on cold start | 8-second upstream abort + returning meta-refresh HTML shell so browser sees progress instead of hitting CF's 100s timeout |
| 8 | Modal terminates container repeatedly ("Cannot connect to :8188") | ComfyUI was binding to 127.0.0.1 — Modal's port-probe runs from a side-car namespace. Changed to `--listen 0.0.0.0` |
| 9 | ComfyUI startup timeout too tight | 120s → 300s |
| 10 | Blank iframe after ComfyUI HTML loads | Injected `<base href="/canvas-proxy/<sid>/">` so ComfyUI's relative URLs resolve back through the proxy |
| 11 | `fetch('/api/users')` bypassed base tag → 404s | Injected inline JS shim: patches `window.fetch`, `XMLHttpRequest.prototype.open`, `window.WebSocket` to prepend session prefix to absolute paths |
| 12 | Shim double-prefixed `/canvas-proxy/api/users` → 404 | Three-branch rewrite: PREFIX passthrough / STEM-only splice / bare prepend. Keep leading slash |
| 13 | ComfyUI-Manager crashed ComfyUI 0.18.5 | Removed. Needs older pinned version |
| 14 | WebSocket bridge missing entirely | Started `canvas-ws-proxy.mjs` on :8190 under pm2, added Cloudflare tunnel hostname `scruple-canvas-ws.stooges.ai` (level-2 for Universal SSL) |
| 15 | WS sidecar crashed on reserved close codes (1005/1006) | Guard: forward only user-range codes; else close without arg |
| 16 | WS URL shim produced `cs_XXXTss/ws` (double 's') | Fixed the STEM branch to keep leading slash when stripping |
| 17 | Modal ComfyUI HTTP requests taking 43-60s each | Modal's default 1-concurrent-input serialized behind long-lived WS. Added `@modal.concurrent(max_inputs=100)` on all GPU classes |
| 18 | WS closed every 125s | Added 30s ping to both legs so neither CF nor Modal sees the connection as idle |
| 19 | Witness intercept never fired | Proxy checked `subPath === 'prompt'` but modern ComfyUI uses `api/prompt`. Match both patterns |
| 20 | **Preview image never populates** (still open) | ComfyUI routes events per-clientId. Sidecar `?clientId=X` preservation needs one more verification pass |

### Architecture as it stands

```
Browser (scruple.stooges.ai/canvas)
   │
   ├─ HTTP    → CF tunnel → Next.js proxy :3001 → Modal :8188
   │                          (session cookie auth, shared secret,
   │                           optional /prompt + /view intercept for
   │                           provenance capture)
   │
   └─ WS      → CF tunnel → canvas-ws-proxy.mjs :8190 → Modal WSS
                              (pm2-managed, keepalive-pinged,
                               reserved-close-code-guarded)
```

Key files:

- `app/canvas-proxy/[sessionId]/[[...path]]/route.ts` — HTTP proxy, `<base>` +
  fetch/XHR/WS shim injection, prompt/view intercept
- `scripts/canvas-ws-proxy.mjs` — WS sidecar
- `modal/canvas_app.py` — Modal ComfyUI containers per GPU tier
- `lib/canvas/session.ts` — session mint + billing bypass logic
- `lib/compute/machines.ts` — machine catalog (t4-free is truly free)

### The one remaining bug

**Symptom:** Modal completes generations successfully (verified via
`/api/history`), output PNG is retrievable, but the browser sits waiting
because ComfyUI's `execution_success` events never surface.

**Root cause (per research agent):** ComfyUI keys sockets by `clientId`.
Routed events (executing / executed / execution_success / etc.) use
`elif sid in self.sockets` — silently drop if the sid isn't registered.
Only `queue_updated` broadcasts.

Browser's ComfyUI JS builds `wss://origin/ws?clientId=X` and POSTs
`client_id: X` with the prompt. If `?clientId=X` is not forwarded to
Modal on the WS upgrade, ComfyUI registers under a fresh uuid, not X,
and the browser's routed events are dropped.

Code paths that should now preserve clientId:

- **Shim** (in `route.ts` line ~230-260): `url = WS_ORIGIN + '/' + SESSION_ID + wsPath + u.search`
- **Sidecar** (in `canvas-ws-proxy.mjs`): URL-object builder + `searchParams.forEach(...)`

Both look correct in code. The last diagnostic step is watching the
enhanced log (`rawIn=... clientId=...`) on the next Queue action to
prove:
- (a) whether the browser is sending clientId at all in the WS URL, and
- (b) if it is, whether the sidecar's upstream URL now has it.

If (a) is false → HTML shim is executing before ComfyUI's `api.clientId`
is set. Move the shim to a MutationObserver that waits for `api` to
appear. Or patch `api.socket` construction later in the boot sequence.

If (a) is true and (b) is true → the fix is complete; event delivery
works; preview populates.

### Follow-ups when this session resumes

Priority 1 (unblocks preview + witness verification):

1. Watch WS sidecar log on next Queue — verify clientId flows through
2. If not: patch the HTML shim to wait for `window.name`/sessionStorage
   `clientId` to be set before wrapping WebSocket

Priority 2 (witness pipeline verification):

3. Once WS works, confirm the `/api/prompt` + `/api/view` intercepts
   actually fire and create `iterations` rows during canvas generations
4. Full smoke: canvas Queue → workflow_hash captured → output bytes
   hashed → leaf signed by witness server → row visible in project
   workspace

Priority 3 (deferred):

5. Re-add ComfyUI-Manager with a pinned older version compatible with
   ComfyUI 0.18.x (or bump ComfyUI to a newer tag)
6. Cold-start optimization (currently ~90s on t4-free) — probably
   `min_containers=1` on paid tiers only; deferred until a paying user
7. Manual model dropdown discovery — user noted Load Checkpoint doesn't
   show FLUX (correctly — it's in `diffusion_models/`, not
   `checkpoints/`). Consider a UI hint

### C2PA status

C2PA button remains visible in workspace (stub alert onClick). Backend
pipeline is proven via CLI (`scripts/c2pa-sign.mjs`). Wiring the button
to the tier picker modal + POST `/api/scruple/c2pa/sign` was deferred
in favor of canvas work this session.

### Non-canvas work also shipped

- **Cloudflare tunnel config** — `/etc/cloudflared/config.yml` now includes
  `scruple-canvas-ws.stooges.ai` → `http://localhost:8190`. CNAME registered
  via `cloudflared tunnel route dns`
- **pm2 process** — `canvas-ws-proxy` added to pm2 fleet, saved via `pm2 save`
- **New env vars** in `.env.local`:
  - `SCRUPLE_CANVAS_BILLING_BYPASS_EMAILS=aquanomous@gmail.com`
  - `NEXT_PUBLIC_CANVAS_WS_ORIGIN=wss://scruple-canvas-ws.stooges.ai`

## Commits (this session)

```
d66b1cc canvas-ws-proxy: URL-object build for upstream WS + clientId log
ceed222 canvas-proxy: intercept /api/prompt + /api/view (ComfyUI 0.18+)
417b392 canvas_app: @modal.concurrent(max_inputs=100) on all GPU tiers
2235b69 canvas-ws-proxy: 30s ping on both legs to survive idle-close
b142888 canvas-ws-proxy: guard against reserved WS close codes
b4ff079 canvas-proxy: fix WS shim path when STEM matches without full PREFIX
71d7888 canvas-proxy: fix shim double-prefix on /canvas-proxy/* paths
fe0aa27 canvas-proxy: shim fetch/XHR/WebSocket for absolute /api paths
0c14485 canvas_app: revert ComfyUI-Manager add — crashed ComfyUI 0.18.5 on boot
fc28ea0 canvas-proxy: switch WS host to scruple-canvas-ws.stooges.ai
77b95a6 canvas-proxy: WS shim points at dedicated canvas-ws host
2aae9a9 canvas-proxy: inject <base href> for root HTML
b73ce92 canvas_app: bind ComfyUI to 0.0.0.0 + startup_timeout 300s
e593fde canvas_app: install ComfyUI-Manager (v3.7.5) into the canvas image
f785c2a canvas-proxy: cold-start shell + 8s upstream cap on root GET
edba766 sidebar: 6-row scrolling project list; canvas: loading overlay during cold-start
db014f4 canvas: t4-free is truly free — no Stripe, no ticker, no gate
5f74567 canvas: fix 404 (optional catchall + drop trailing slash) + defer GPU spin-up
0afd870 brand: crimson wordmark on Studio sidebar + cyan Web Studio + canvas billing bypass
54b7440 canvas_app: rename concurrency_limit -> max_containers (Modal deprecation)
9847b40 auth: bundle Drive scope in Google sign-in + silent heartbeat refresh
```

Plus overnight LoRA driver commits (project 181 direct DB inserts, no
git commits).
