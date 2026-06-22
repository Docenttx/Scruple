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

