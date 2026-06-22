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

