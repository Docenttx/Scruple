# Live Blender smoke

Runs the installed addon inside a real Blender process (headless).
Not part of the default `pytest` run because it needs Blender on PATH.

## Run

```
# Install the built zip into Blender's addons dir
BLENDER_ADDONS=~/.config/blender/3.0/scripts/addons   # or 4.2/scripts/addons etc.
mkdir -p "$BLENDER_ADDONS"
rm -rf "$BLENDER_ADDONS/scruple_blender"
unzip -q ../../dist/scruple-blender-*.zip -d "$BLENDER_ADDONS"

# Headless run (xvfb-run needed on servers with no X)
xvfb-run -a blender --background --python smoke_blender.py
```

## What it verifies

- Addon enables without exceptions.
- `bpy.app.handlers.{render_complete, render_write, save_post}` each
  have exactly one scruple_blender-tagged handler.
- Every `scruple.*` operator registers, WO-B5's six dashboard ones
  included.
- All six panel classes are on `bpy.types`: `SCRUPLE_PT_main` and the
  five sub-panels. A sub-panel whose `bl_parent_id` does not resolve
  registers without error and is silently absent from the N-panel,
  which is why each is named rather than counted.
- Addon preferences readable (`base_url`).
- A minimal Cycles render completes without crashing (the
  render_complete handler is exercised on the render bytes path).
- Addon disables cleanly.

## Validated against

- Blender 3.0.1 (Ubuntu 22.04 arm64, apt) — 2026-07-16, all 16 checks pass.

Blender 4.2+ x86_64 not run in this session (no x86_64 host available).
The bl_info fallback path is what 3.0 exercises; the 4.2 Extensions
manifest is verified by the packager test in `tests/test_packaging.py`
and by manual install per `SESSION_REPORT_2026-07-17.md`.

## dashboard_in_blender.py (WO-B5)

The dashboard, driven inside real Blender against the scratch stack.
Proves the three things the mock-bpy suite structurally cannot: that the
panel classes register (real Blender validates `bl_parent_id` and
`poll`), that every operator property the panel sets is declared (the
mock accepts any attribute), and that switching project changes the
`project_id` on the row the app writes.

```
cd /mnt/corpus/scruple-blender-l2 && . ./env.sh
export SCRUPLE_B5_API_KEY="$(cat b3-live-api-key.txt)"
export SCRUPLE_SCRATCH_DB="$SCRUPLE_DB_PATH"
export SCRUPLE_B5_BASE=/mnt/corpus/scruple-blender-l2/b5
blender --background --factory-startup --python \
  /data/scruple-blender/tests/live/dashboard_in_blender.py
```

It writes `$SCRUPLE_B5_BASE/dashboard-phases.jsonl`. The graded output is
`docs/canon/blender-l2/05-dashboard-phases.jsonl`.

It writes its API key into `$SCRUPLE_B5_BASE/auth/`, never `~/.scruple`.
