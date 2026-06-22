# WO-1 · Tactical seedvr2 unblock — independent of v2

**Scope:** Add VideoHelperSuite + seedvr2 (scruple-canvas-fork branch) to the existing per-request Modal runner so the existing `/api/generate` path can execute seedvr2 workflows. Independent of the canvas v2 rebuild — ships immediately.

**Reference:** `docs/architecture/canvas-v2.md` build plan step 1.

## Files

- `modal/scruple_runner.py` — extend `comfy_image` builder block

## Changes

1. In `comfy_image.run_commands(...)`, after the Easy-Use clone, add:
   - Clone `Kosinkadink/ComfyUI-VideoHelperSuite` @ pinned ref → `custom_nodes/ComfyUI-VideoHelperSuite`
   - Install its requirements
   - Clone our `external/scruple-nodes/seedvr2_videoupscaler` fork (scruple-canvas-fork branch) → `custom_nodes/seedvr2_videoupscaler`
   - Install its requirements
2. `modal deploy modal/scruple_runner.py` (user-run; document command in commit msg)

## Verify

- `git diff modal/scruple_runner.py` shows additions only
- `modal deploy` log shows VHS + seedvr2 packs installed; container builds clean
- (Manual) re-run the workflow the user tried earlier; no missing_node_type

## Out of scope

- Modal canvas app changes (deferred to WO-3+)
- Node parity audit (already done in CV-5)
- modal deploy itself — user runs it after the commit lands
