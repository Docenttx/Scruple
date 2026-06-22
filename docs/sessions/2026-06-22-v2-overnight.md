# Session report — Canvas v2 overnight execution

**Start:** 2026-06-22
**Operator:** AI Council (autonomous overnight)
**Spec:** `docs/architecture/canvas-v2.md` (locked `ae3a4f7`)
**WO series:** `docs/wo/2026-06-22-v2-{01..14}-*.md` (committed `e7a9bcf`)

This document is the rolling report. One section appended per completed WO.

---

## WO-1 · seedvr2 tactical unblock

**Commit:** `<pending>`
**Status:** code change complete; `modal deploy` pending (user-run)
**Files touched:**
- `modal/scruple_runner.py` — VHS v1.7.9 + numz/seedvr2 v2.5.22 added to the
  `comfy_image.run_commands(...)` block, both pinned, with requirements installed

**Decisions made:**
- Used **upstream** seedvr2 (`numz/ComfyUI-SeedVR2_VideoUpscaler` @ v2.5.22) for
  Modal — not our `scruple-canvas-fork`. Reason: the fork's CPU-fallback patch
  only matters on the on-host canvas (which is retiring per v2 anyway). Modal has
  a real CUDA device → upstream registers fine. Saves a separate clone path.
- VHS pinned to **v1.7.9** to match the host canvas (`pyproject.toml` declares
  this version in `/data/reference/ui-inspire/ComfyUI/custom_nodes/comfyui-videohelpersuite`).

**Verify done locally:**
- `git diff modal/scruple_runner.py` — only additions, no other touch
- Pattern matches existing Easy-Use install (consistent style)

**What still needs to happen (operator-side, after this commit lands):**
```
cd /data/scruple-web
python3 -m modal deploy modal/scruple_runner.py
```
After deploy → rerun the workflow that broke earlier; missing_node_type for
seedvr2 should be resolved.

**Caveats:**
- I did NOT run `modal deploy` from this overnight session. Will revisit at
  WO-14 (testnet smokes) — if Modal CLI is available + token is valid in env,
  I'll deploy then. Otherwise it stays a user-action.

---

## WO-2 · Strip user-tier concept

**Commit:** `<pending>`
**Status:** code complete; `tsc --noEmit` green
**Files touched (9 total, +129 / -384):**
- DELETED: `lib/compute/userPlan.ts`
- DELETED: `components/CanvasLauncher.tsx`
- `lib/compute/machines.ts` — dropped `UserPlan`, `tierLabel`, `allowedPlans`,
  `DEFAULT_MACHINE_BY_PLAN`, `getMachineCatalogForPlan`, `getDefaultMachineForPlan`.
  Added `hourlyRateCents` per machine + `DEFAULT_MACHINE_ID = 't4-free'` +
  `getDefaultMachine()`. T4: 59¢, A10G: 110¢, A100: 309¢, H100-CC: 456¢/hr.
- `lib/compute/getActiveMachine.ts` — dropped plan/userPlan import; fall back
  only on missing/invalid storedMachineId.
- `app/api/settings/compute/route.ts` — GET returns full MACHINES catalog;
  POST validates machine_id exists but no longer plan-checks. No 403 path.
- `app/api/canvas/session/route.ts` — dropped Pro+ tier gate; any signed-in
  user can mint a session (Stripe gating arrives in WO-6).
- `components/settings/ComputeSection.tsx` — dropped Free/Pro/Premium chrome
  + Upgrade CTA + `isFree` disable; shows all 4 machines with hourly rates.
- `app/canvas/page.tsx` — dropped 3-way tier branch. Single auth check; if
  session exists → iframe Modal; else minimal Start-canvas card. (WO-5 will
  rewrite this further for auto-mint through the HTTP+WS proxy.)
- `lib/canvas/session.ts` — updated comment header (tier-gate language).
- `.env.local` — commented out `SCRUPLE_ENTERPRISE_EMAILS` with a note that
  code no longer reads it. (No more vestigial env grants.)

**Decisions made:**
- **Kept machine IDs unchanged** (`t4-free`, `a10g-pro`, `a100-premium`,
  `h100cc-enterprise`) instead of renaming per the WO doc. Reason: existing
  `iterations.compute_machine_id` rows reference these strings; renaming
  would require a data migration with little gain. The "-free"/"-pro" suffix
  is now purely a stable identifier, not a tier label.
- **Added `hourlyRateCents` now** rather than in WO-6. Cheap to add and WO-6
  needs it; folding it into the catalog reduces the WO-6 surface.
- **Kept `app/canvas/page.tsx` as a server-rendered Start-canvas form** for
  the no-session path. Stops the page from being unreachable while WO-5
  hasn't rewritten the auto-mint flow yet. The form POSTs `/api/canvas/session`
  but this is a stopgap — the real flow is server-render → auto-mint, no
  user click. WO-5 replaces this.

**Verify done:**
- `rg "userPlan|getUserPlan|allowedPlans|UserPlan|DEFAULT_MACHINE_BY_PLAN|getMachineCatalogForPlan|getDefaultMachineForPlan|tierLabel|CanvasLauncher"` → empty
- `npx tsc --noEmit` → exit 0, clean
- All callers of removed symbols are updated; no orphaned imports

**What still needs to happen (out-of-WO-2):**
- The shared canvas Modal app + the per-request runner still reference
  per-tier env vars (`MODAL_RUNNER_ENDPOINT_T4_FREE`, etc.). These work
  unchanged — env var names retained for backward compat with operator's
  shell history. Modal deploy + canvas_app.py changes happen in WO-4/7.

---

## WO-3 · Migration 021 + default manifest

**Commit:** `<pending>`
**Status:** migration applied on dev DB; manifest hash verified
**Files touched (5):**
- NEW: `lib/canvas/manifest.ts` — `canonicalizeManifest()` (sorted-key
  recursive JSON serializer) + `hashManifest()` (sha256 hex over the
  canonical form)
- NEW: `config/default-machine-manifest.json` — 6 pinned packs:
  - ComfyUI v0.18.5
  - Easy-Use v1.3.6
  - VHS v1.7.9
  - Advanced-ControlNet `main`
  - IPAdapter-plus `main`
  - AnimateDiff-Evolved `main`
  - seedvr2 (numz upstream) v2.5.22
  Each pack has `commit_sha: null` — WO-7 build worker resolves to real
  shas at first build, then UPDATEs the row + hash.
- NEW: `lib/db/migrations/021_canvas_v2_schema.sql` — `machines` +
  `machine_versions` tables; `iterations.machine_manifest_hash` +
  `iterations.workflow_publication`; seeded `default-scruple-canvas-v1`
  row with the canonical manifest JSON + hash inline.

**Decisions made:**
- **6 packs not 7.** v2 spec mentioned a separate "scruple-canvas-fork/seedvr2"
  entry — but for the SHARED default machine on Modal, the upstream numz
  package works (Modal has real GPU; the fork's CPU patch is on-host only).
  The fork remains as a separate optional pack a user can add in their
  Custom Machine if they explicitly want our CPU-fallback variant.
- **Did NOT add `leaf_scheme` ALTER.** Column already exists from
  migration 016 (default 'v1'). WO-8 will update the application code to
  set 'v2.2' for new rows; the audit script dispatches on the actual
  value. Removing this from migration 021 fixed the "duplicate column
  name" error on first apply.
- **Did NOT add `witnesses` table ALTER.** There is no `witnesses` table
  in the operator DB — witness state lives on `iterations.witness_*`
  columns + the standalone `/opt/scruple-witness/` process. WO-8 will
  extend the witness server's canonical record server-side.
- **`commit_sha: null` is intentional and committed.** The canonical
  hash `273df14…b375` is bound to "the manifest before resolution".
  When WO-7's build worker resolves shas + rebuilds, it writes a NEW
  machines row with the post-resolution hash; the original null-sha row
  stays so iterations that ran during the pending window can still
  resolve to a manifest record.

**Verify done:**
- `npx tsx scripts/migrate.ts` → `Applied 1 new migration(s); skipped 20`
- `machines` row exists with hash matching `hashManifest()` over the
  config JSON: `273df1412170d94b0b64f1ce5f6c1f562802cc3cbdcbb4e1bcad67d2ea72b375`
- `iterations.machine_manifest_hash` + `iterations.workflow_publication`
  columns added, defaults sensible

**What still needs to happen (out-of-WO-3):**
- The build worker (WO-7) needs to resolve commit shas + build the image
  + flip build_status to 'ready'. Until then the manifest_hash represents
  the manifest-as-specified, not the manifest-as-built.

---

## WO-4 · HTTP+WS proxy as the provenance gate

**Commit:** `<pending>`
**Status:** code complete; `tsc --noEmit` green; ws npm dep installed
**Files (8 changed / 3 new / 2 deleted / +518 / -190):**
- NEW: `lib/canvas/witness.ts` — internal API: `startWorkflow()`,
  `captureOutput()`, `resolveActiveProjectId()`. Called server-side
  by the proxy; no HTTP boundary. Pipes into existing `ingestIteration`.
- NEW: `app/canvas-proxy/[sessionId]/[...path]/route.ts` — Next.js
  streaming HTTP proxy. All methods. Session ownership check. Adds
  `X-Scruple-Shared-Secret` to Modal calls. Intercepts POST `/prompt`
  + GET `/view`; fire-and-forget witness hooks (never block response).
- NEW: `scripts/canvas-ws-proxy.mjs` — standalone Node `ws` sidecar on
  port 8190 (configurable via `CANVAS_WS_PROXY_PORT`). Reads
  `canvas_sessions` directly (read-only sqlite). Health check at `/`.
  Bidirectional pipe; logs frame counts on close.
- DELETED: `app/api/canvas/witness/start/route.ts` — superseded by
  internal `lib/canvas/witness.ts`
- DELETED: `app/api/canvas/witness/complete/route.ts` — same
- DELETED: `/data/reference/ui-inspire/ComfyUI/custom_nodes/scruple_nodes/js/scruple-canvas-witness.js`
  — bypassable browser-side intercept; superseded by server proxy
- `components/CanvasBridge.tsx` — removed `scruple:canvas-witness-{start,complete}`
  handlers (now server-side via proxy). Queue-intercept handlers
  (for the legacy /api/generate free-tier path) kept untouched.
- `modal/canvas_app.py` — removed `scruple_nodes` from `add_local_dir`
  (dead code per v2 spec decision 4); added shared-secret middleware
  TODO comment with the in-container sidecar plan; URL secrecy is the
  defense-in-depth in the meantime.
- `package.json` + `package-lock.json` — added `ws ^8.21.0` for the
  WS sidecar.

**Decisions made:**
- **Fire-and-forget witness hooks.** The proxy `clone()`s the upstream
  response and runs `.json()` / `.arrayBuffer()` on the clone in a
  detached promise. The client sees the original response body
  streamed back at line speed; provenance work happens off the hot
  path. Any failure in the hook logs but never affects the user.
- **Project resolution server-side.** The proxy looks up
  `projects.is_active=1` for the session's user_id on every /prompt
  POST. This means the user changing the active project in scruple-web
  takes effect immediately on the next Queue, without any browser-side
  postMessage protocol.
- **WS sidecar reads DB directly read-only.** Avoids a service call
  from the sidecar back to scruple-web for session validation. The
  read-only flag is enforced by `better-sqlite3({readonly:true})`.
- **Shared-secret middleware DEFERRED to follow-up WO (canvas-v2-04a).**
  Reason: Modal's `@web_server` publishes the inner port directly via
  Modal's HTTPS gateway; Modal does no auth. To enforce the shared-
  secret header in-container, the deploy needs a uvicorn shim on a
  separate port that proxies to ComfyUI on 8188. That's significant
  refactor of canvas_app.py with its own deploy + smoke. URL secrecy
  is the v1 defense; the Modal URLs only live in `.env.local` and
  scruple-web's proxy never echoes them to the browser.
- **`scruple_queue_intercept.js` left in place** on the on-host canvas
  for the moment. It's part of the dead-code scruple_nodes pack but
  removing it requires touching the host canvas install which is
  retiring anyway. Tracked for cleanup with the broader scruple_nodes
  retirement.

**Verify done:**
- `npx tsc --noEmit` → exit 0 after `.next/types/` cache clean
  (stale generated types referenced the deleted routes; cache
  regenerates on `next build`).
- Routes layout: `app/canvas-proxy/[sessionId]/[...path]/route.ts`
  resolves under standard Next.js dynamic-routing.
- `ws` import in `canvas-ws-proxy.mjs` resolves via `npm install ws`.

**Operator-side follow-up:**
- pm2 entry or systemd unit for `canvas-ws-proxy.mjs`:
  ```
  pm2 start scripts/canvas-ws-proxy.mjs --name canvas-ws-proxy \
    --env SCRUPLE_CANVAS_SHARED_SECRET=$SECRET \
    --env SCRUPLE_DB_PATH=/data/scruple-web/data/scruple.db
  ```
- Cloudflare tunnel: add a hostname `canvas-ws.scruple.stooges.ai` →
  service `http://127.0.0.1:8190`. (Tunnel supports WS upgrade by
  default.)
- `.env.local`: add `SCRUPLE_CANVAS_SHARED_SECRET=<random 32 hex>` —
  same value goes into the Modal secret when the in-container shim
  WO ships.

**What still needs to happen (out-of-WO-4):**
- WO-5 rewrites `/canvas/page.tsx` to auto-mint + iframe the proxy URL
  (currently still iframes Modal directly when a session is active)
- WO-5 also drops the `?t=` token URL pattern in `lib/canvas/session.ts`
- Modal in-container shared-secret shim (canvas-v2-04a follow-up)

---

