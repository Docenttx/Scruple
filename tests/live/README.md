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
- All nine `scruple.*` operators register.
- `SCRUPLE_PT_main` panel class is on `bpy.types`.
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
