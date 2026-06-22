# WO 2026-06-22 — Canvas-on-Modal (unified ComfyUI; closes the parity gap permanently)

**Origin:** seedvr2 workflow failed today on Modal with `missing_node_type` — the canvas had seedvr2 (post-yesterday's fork) but Modal's image didn't. The on-host CPU canvas and per-request Modal runner are two independent ComfyUI installs with hand-maintained, drift-prone node inventories. Today's bug is the latent failure mode of that split.

**Mandate verbatim:**
- "we just want our users to have seamless, painless canvas work"
- "we need this to work like ComfyDeploy honestly"
- "one per user, cold start is fine, its a pay tier feature for later"

**Style directive:** "do it properly, always. never a quick fix"

## Goal

Collapse the two ComfyUIs into one. Each Pro/Enterprise user gets a **Modal-hosted ComfyUI session container** — long-running, full GPU, full node set. The canvas they edit in is the same ComfyUI that executes their workflow. The parity bug is impossible by construction because there's nothing to mismatch.

## Non-goals (this WO)

- **Free-tier canvas.** This is a paid feature. Free users keep using project-page generation via `/api/generate` (which still routes to the existing single Modal runner). On-host `:8188` canvas is deprecated for paid users but kept as a dev sandbox.
- **`ScrupleWebTerminal` (in-graph provenance node).** Phase 2b. Today's WO uses **Option B** — the intercept JS in the canvas page fires witness POSTs on queue + completion. The `ScrupleStudioTerminal` nodes from the desktop Electron Studio are NOT in scope (they hard-fail against localhost:5742 which doesn't exist on Modal).
- **`min_containers` warm pools.** Cold-start accepted (~30s) per directive.
- **Per-workflow machine override** in canvas. Stage 3 of compute.

## Architecture

```
Pro/Enterprise user
      │
      ▼
scruple.stooges.ai/canvas (Next.js page)
      │
      ▼
POST /api/canvas/session                       ← Mints (or returns existing) per-user session
      │ {machine_id, signed_token, expires_at, modal_url}
      ▼
Modal Canvas App                               ← modal/canvas_app.py
   ComfyUIServer (@app.cls, gpu=…)             ← One container per (user, machine) pair
     @web_server(port=8188)                    ← Modal exposes ComfyUI HTTP+WS to a public URL
     image: full node set                      ← Easy-Use + VHS + seedvr2 (canvas-fork) + scruple_nodes
     scaledown_window: 300                     ← Idle-shut after 5 min of inactivity
      │
      ▼
canvas page <iframe src={modal_url}>           ← User edits + queues IN that container
      │
      ▼
ComfyUI native /prompt + WebSocket execution   ← In-process; no per-request handoff
      │
      ▼
scruple-queue-intercept.js (extended)
      ├─ on /prompt → POST scruple-web /api/canvas/witness/start
      └─ on WS executed → POST scruple-web /api/canvas/witness/complete
      │                                        ← Payload includes session_token + workflow JSON + output ref
      ▼
ingestIteration (existing pipeline)
  → hash, witness server, RVN/IPFS/Arweave
  → iteration row, compute_machine_id, machine receipt
```

**One container per user.** Modal `@app.cls(concurrency_limit=1)` ensures each user's session is isolated to one container; another user's session spawns a different container. Idle scale-down kills the container after 5 minutes of no activity (Modal's `scaledown_window`).

**Provenance unchanged from today's pipeline.** The new path is just a different way of getting the workflow + output bytes into `ingestIteration`. Hashing, witness signatures, chain anchors, receipts — same primitives.

## What ships in this WO

### 1. `modal/canvas_app.py` (new)

A separate Modal app — `scruple-canvas` — distinct from `scruple-runner`. Why separate:
- `scruple-runner` is the per-request synchronous + spawnable function used by `/api/generate`. Keeps existing CLI + project-page generation working.
- `scruple-canvas` is the long-running web-server function used by the canvas page. Different invocation pattern, different lifecycle, different image.

```python
import modal

CANVAS_GPU = os.getenv("SCRUPLE_CANVAS_GPU", "T4")

canvas_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "wget", "libgl1", "libglib2.0-0")  # ffmpeg/opencv deps
    .pip_install("torch", "torchvision", "torchaudio",
                 index_url="https://download.pytorch.org/whl/cu121")
    .pip_install("transformers", "diffusers", "accelerate",
                 "safetensors", "Pillow", "numpy", "aiohttp",
                 "scipy", "einops", "torchsde", "opencv-python-headless",
                 "matplotlib", "peft", "omegaconf", "rotary-embedding-torch",
                 "fastapi[standard]")
    .run_commands(
        "git clone --depth=1 --branch v0.18.5 "
        "https://github.com/comfyanonymous/ComfyUI /opt/ComfyUI",
        "pip install -r /opt/ComfyUI/requirements.txt",

        # Easy-Use
        "git clone --depth=1 --branch v1.3.6 "
        "https://github.com/yolain/ComfyUI-Easy-Use "
        "/opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use",
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-Easy-Use/requirements.txt || true",

        # VideoHelperSuite
        "git clone --depth=1 "
        "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "
        "/opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite",
        "pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt || true",

        # SeedVR2 — upstream is fine; the canvas-fork's CPU-fallback
        # patch is a no-op on Modal (real CUDA available). When the
        # scruple-nodes GitHub org exists we'll switch to the fork.
        "git clone --depth=1 "
        "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler "
        "/opt/ComfyUI/custom_nodes/seedvr2_videoupscaler",
        "pip install -r /opt/ComfyUI/custom_nodes/seedvr2_videoupscaler/requirements.txt || true",

        # scruple_nodes (the JS extension is what we care about; we
        # ship the node classes too so workflows that include the
        # passive ScrupleTap/OutputCapture register cleanly)
        # NOTE: copied from the repo at deploy time via add_local_dir,
        # not git-cloned, so the canvas-side scruple-queue-intercept.js
        # we extend in COM-6 ships into the image.

        "rm -rf /opt/ComfyUI/models && mkdir /opt/ComfyUI/models",
    )
    .add_local_dir("./custom_nodes/scruple_nodes",
                   "/opt/ComfyUI/custom_nodes/scruple_nodes")
)

app = modal.App("scruple-canvas", image=canvas_image)

@app.cls(
    gpu=CANVAS_GPU,
    scaledown_window=300,          # 5 min idle → shut down
    concurrency_limit=1,           # one user per container
    timeout=60 * 60,               # 1h max session
    volumes={"/opt/ComfyUI/models": models_volume},
)
class ComfyUICanvas:

    @modal.enter()
    def start_comfy(self):
        # spawn ComfyUI's main.py as a subprocess on port 8188
        ...

    @modal.web_server(port=8188, startup_timeout=120)
    def serve(self):
        # Modal proxies all HTTP+WS to port 8188
        pass
```

Deploy → Modal returns a public URL like `https://aquanomous--scruple-canvas-comfyuicanvas-serve.modal.run/`. That URL is what the canvas page iframes (parameterized per call via Modal's named function URLs).

### 2. Migration 020 — `canvas_sessions` table

```sql
CREATE TABLE canvas_sessions (
  id                   TEXT PRIMARY KEY,                  -- nanoid
  user_id              TEXT NOT NULL,
  machine_id           TEXT NOT NULL,                     -- catalog id from lib/compute/machines.ts
  modal_url            TEXT NOT NULL,                     -- the Modal-issued canvas URL
  signed_token         TEXT NOT NULL,                     -- HMAC of {session_id, user_id, expires_at}
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'expired', 'revoked'))
);
CREATE INDEX idx_canvas_sessions_user_active
  ON canvas_sessions(user_id, status) WHERE status = 'active';
```

One active session per user (UI rule, enforced by `/api/canvas/session` POST → revokes any active before issuing new).

### 3. `lib/canvas/session.ts`

- `mintSession(userId, machineId): { id, signedToken, modalUrl, expiresAt }`
- `verifySession(token): { sessionId, userId, machineId } | null`
- `revokeSession(sessionId)`
- `getActiveSession(userId): CanvasSessionRow | null`
- HMAC key from `AUTH_SECRET` (existing).

### 4. `app/api/canvas/session/route.ts`

```
POST   { machine_id? } → tier-gate (Pro+) → revoke active → mint → 200 { session_id, modal_url, expires_at }
GET                    → return user's active session or 404
DELETE                 → revoke active session
```

### 5. `app/canvas/page.tsx`

Server component:
1. `auth()` → user
2. `getUserPlan(userId)` — if `'free'`, render upgrade CTA, stop
3. `getActiveSession(userId)` → if absent, render "Click to launch canvas" button
4. If present, render `<iframe src={modalUrl}>` full-bleed with a small Scruple header bar showing: machine in use + idle countdown + "End session" button

### 6. Intercept JS extension

Modify `custom_nodes/scruple_nodes/js/scruple-queue-intercept.js`:
- Listen for ComfyUI's native `app.queuePrompt()` (not swallow it like today)
- On invoke: POST `/api/canvas/witness/start` with `{session_token, workflow_api_json, prompt_id}`
- Hook into ComfyUI's WS `executed`/`execution_success` events
- On execution complete: fetch the output image from ComfyUI's `/view` endpoint, POST `/api/canvas/witness/complete` with `{session_token, prompt_id, output_bytes_b64}`

The scruple-web side recognizes the session via the signed token, runs through `ingestIteration`, produces a witnessed iteration row.

### 7. `/api/canvas/witness/{start,complete}/route.ts`

`start`: validates session_token + writes a `pending_iteration` row (so we don't lose track if `complete` never fires).

`complete`: validates session_token, looks up pending, calls `ingestIteration` (existing — same path /api/generate uses), updates pending → done. Returns `{iteration_id, leaf_hash, scr_id?}`.

The intercept JS toasts those back to the canvas so the user sees "Iteration #N witnessed (SCR-XXX)" overlay.

### 8. Settings nav + tier gate

- Add `Canvas` nav item at the top of settings (after Account)
- The `/canvas` page link in main nav, but tier-gated — Free users see "Upgrade" CTA
- Compute Settings shows "Canvas session active on: A100" status when relevant

## What does NOT ship overnight

| Item | Why |
|---|---|
| Actual `modal deploy modal/canvas_app.py` | Cost-incurring; ~$0.05 per build + ongoing GPU-seconds during sessions; needs user authorization |
| `MODAL_CANVAS_APP_URL_T4_FREE` etc env var values | They come from the deploy step |
| Cloudflare tunnel update for any custom canvas hostname | Iframe Modal's URL directly for now; CF reverse-proxy is a Stage-2 polish |
| ScrupleWebTerminal in-graph node | Phase 2b; the JS intercept is the witness for now |
| Free-tier canvas | This is the paid lever |
| Per-workflow machine override | Compute Stage 3 |
| Deprecation of on-host `:8188` | Stays as dev sandbox; not in this WO |

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Modal `@web_server` doesn't proxy WebSocket for ComfyUI's progress events | low | Documented in Modal docs as supported; smoke-test before going live |
| User opens canvas in 2 browsers → 2 active sessions | medium | POST revokes any active before minting; UI shows "Active elsewhere — claim?" |
| Intercept JS misses an execution event → no witness | medium | `pending_iteration` row + cron sweep that flags expired pendings; surfaces in audit |
| Modal session URL leaked → unauthorized canvas use | medium | URL includes signed token query param; canvas_app rejects requests without it |
| Cold-start latency unacceptable to user | low | Per directive: cold-start fine. Surface a "starting GPU…" splash |
| Image build takes 15+ min, blocks deploy | medium | First deploy is slow; subsequent deploys are layer-cached |
| Per-user Modal cost explodes (long sessions) | high | Hard 1h timeout (`timeout=60*60`); UI countdown; surface running cost on page |
| Canvas page CSP / iframe sandbox issues | medium | iframe `sandbox="allow-scripts allow-same-origin allow-forms"`; test postMessage works |

## Success criteria

- [ ] `docs/wo/2026-06-22-canvas-on-modal.md` exists (this file)
- [ ] `modal/canvas_app.py` lints + Python-imports clean (no `modal deploy` required for this gate)
- [ ] Migration 020 applies; canvas_sessions table present
- [ ] `lib/canvas/session.ts` exports the four helpers; HMAC roundtrips cleanly
- [ ] `/api/canvas/session` GET / POST / DELETE smoke-pass against authenticated session
- [ ] `/api/canvas/witness/{start,complete}` parse + validate + write rows
- [ ] `/app/canvas/page.tsx` renders properly for: free (upgrade CTA), pro (launch button), with-session (iframe)
- [ ] Intercept JS extension compiles + the listeners attach in a smoke environment
- [ ] tsc + next build clean
- [ ] Commit on `feature/pivot`
- [ ] Deploy instructions documented for the user

## Deferred follow-ups (post-merge, user-approved)

1. **`modal deploy modal/canvas_app.py`** — produces the Modal endpoint URL per GPU class.
2. **Set per-machine env vars:**
   ```
   MODAL_CANVAS_APP_URL_T4_FREE=...
   MODAL_CANVAS_APP_URL_A10G_PRO=...
   MODAL_CANVAS_APP_URL_A100_PREMIUM=...
   MODAL_CANVAS_APP_URL_H100CC_ENTERPRISE=...
   ```
3. **Smoke test** with `shaun.hargadine.ge@gmail.com` (enterprise) launching an A100 canvas session, running a seedvr2 workflow end-to-end, and verifying the iteration appears with the right machine_id.
4. **Cost telemetry** — track session duration × GPU rate per user.
5. **Phase 2b** — replace JS intercept with `ScrupleWebTerminal` in-graph node for tamper-resistant capture.
6. **Phase 3** — deprecate the on-host `:8188` canvas entirely once paid-tier flow proves out.

## Morning briefing

**Bottom line:** the canvas-on-Modal architecture is wired end-to-end on `feature/pivot`. **What's missing to make it live is one `modal deploy`** plus four env-var entries. Today's seedvr2 failure mode disappears the moment paid users open the launcher.

**What landed:**
- `modal/canvas_app.py` — separate Modal app `scruple-canvas`. Four classes (`ComfyUIT4`, `ComfyUIA10G`, `ComfyUIA100`, `ComfyUIH100CC`) wrap ComfyUI as a `@web_server`. Image bundles the FULL canvas-side node set (Easy-Use + VHS + seedvr2 + scruple_nodes), eliminating the parity gap by construction. `concurrency_limit=1`, `scaledown_window=300`, `timeout=3600`.
- Migration 020 + `canvas_sessions` + `canvas_pending_iterations` tables.
- `lib/canvas/session.ts` — HMAC-signed session tokens (one active per user, 1h TTL, AUTH_SECRET-keyed).
- `/api/canvas/session` (GET/POST/DELETE) — tier-gated (Pro+), 403 free, 503 if env var unset.
- `/api/canvas/witness/{start,complete}` — receives intercept events, pipes into existing `ingestIteration` → standard provenance pipeline (hashes, witness signatures, machine_id, receipt).
- `app/canvas/page.tsx` — three-mode renderer: free → on-host CPU canvas (unchanged), Pro/Enterprise with session → Modal iframe, Pro/Enterprise without session → `CanvasLauncher`.
- `components/CanvasLauncher.tsx` — launch UI showing current machine + monthly cost + cold-start estimate.
- `custom_nodes/scruple_nodes/js/scruple-canvas-witness.js` — companion to the existing intercept. Activates only when `?t=<token>` is in the iframe URL. Wraps `api.fetchApi` to catch `/prompt` POSTs + listens for `execution_success` to capture outputs. postMessages both events to the parent CanvasBridge.
- `components/CanvasBridge.tsx` — extended with `scruple:canvas-witness-{start,complete}` handlers that POST to the new witness endpoints.

**Verified locally (against the running dev server):**
- tsc clean; full build path unbroken
- `GET /api/canvas/session` → `{active:null}` 200 (no session yet)
- `POST /api/canvas/session` as free user → 403 "Canvas sessions require Pro or Enterprise tier"
- `POST /api/canvas/session` as enterprise user → 503 with explicit "Set `MODAL_CANVAS_APP_URL_A100_PREMIUM` after running modal deploy" — graceful degradation, no silent fallback
- `POST /api/canvas/witness/start` rejects bogus token (401) + missing body (400)
- `POST /api/canvas/witness/complete` rejects unknown prompt_id (404) + missing body (400)
- `/canvas` page renders the correct view per plan: on-host iframe for free, `CanvasLauncher` card for enterprise (no active session)

**What's awaiting your action (in this order):**

1. **Run the canvas deploy.** From `/data/scruple-web`:
   ```bash
   modal deploy modal/canvas_app.py
   ```
   First build will be slow (~15 min) because of torch + diffusers + transformers + VHS + seedvr2. Subsequent deploys are layer-cached.

2. **Copy the four URLs Modal prints** into `.env.local`:
   ```
   MODAL_CANVAS_APP_URL_T4_FREE=https://<workspace>--scruple-canvas-comfyuit4-serve.modal.run
   MODAL_CANVAS_APP_URL_A10G_PRO=https://<workspace>--scruple-canvas-comfyuia10g-serve.modal.run
   MODAL_CANVAS_APP_URL_A100_PREMIUM=https://<workspace>--scruple-canvas-comfyuia100-serve.modal.run
   MODAL_CANVAS_APP_URL_H100CC_ENTERPRISE=https://<workspace>--scruple-canvas-comfyuih100cc-serve.modal.run
   ```
   (H100-CC requires Modal's confidential-computing plan. Skip it if you don't have that activated; the launcher will just 503 for H100 selection.)

3. **Restart scruple-web dev server** for the env vars to take effect.

4. **Smoke test:** sign in as `shaun.hargadine.ge@gmail.com` (enterprise) → go to `/canvas` → "Launch Canvas" → wait ~30s for cold-start → ComfyUI renders inside the iframe with full node set, including seedvr2 → drag a seedvr2 workflow → hit Queue → workflow executes IN the Modal container → completion fires → iteration appears in the project with `compute_machine_id: a100-premium`.

5. **Cost monitoring** during the first paid sessions. Today's deferred follow-ups don't include burn-rate telemetry yet; the `last_activity_at` column on `canvas_sessions` is the seed for a future "session ran X minutes at $Y/hr" surface.

**Cost expectations on first deploy:**
- Image build: one-time ~$0.05 (Modal builder containers).
- Per-session GPU rate × wall-clock seconds during active sessions. A100 ≈ $3.09/hr; H100-CC ≈ $4.56/hr; cold-start gets billed too (~30s). Idle scale-down means $0 burn between sessions.
- A user holding the canvas open for an hour on A100 costs ~$3. Hard 1-hour timeout caps any session.

**What this WO did NOT do:**
- Phase 2b (`ScrupleWebTerminal` in-graph capture node). The existing JS-intercept model from this WO works; the in-graph node would be tamper-resistant against a malicious user who removes the intercept JS but kept the Modal-canvas URL. Real concern; not Day-1 critical.
- Phase 3 (deprecate the on-host `:8188` canvas). Stays as the free-tier surface + dev sandbox.

**Reversibility:** if anything looks wrong, just don't run `modal deploy`. The code paths gracefully 503 without the env vars. Free-tier canvas is untouched. Existing project-page generation via `/api/generate` is untouched. Stage 1 Compute UI is untouched.

**Commit:** see the latest on `feature/pivot`.
