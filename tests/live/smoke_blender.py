"""Headless Blender smoke test for the Scruple addon.

Run: blender --background --python smoke_blender.py

Verifies:
  1. Addon enables without exceptions.
  2. Handler callbacks are registered on bpy.app.handlers.
  3. Panel and operator classes are registered as bpy.types.
  4. Preferences accessible.
  5. A minimal render triggers the render_complete callback path
     (best-effort: our capture may bail gracefully if no auth token,
     which is EXPECTED — the smoke is that Blender doesn't crash and
     the callback signature is honoured).
  6. Addon disables cleanly.

Exit 0 on all pass, 1 on any failure.
"""

import sys
import os
import traceback

FAILURES = []


def _report(name, ok, detail=""):
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def main():
    import bpy

    print(f"Blender version: {bpy.app.version_string}")
    print(f"Python: {sys.version.split()[0]}")
    print("---")

    # 1. Enable addon
    try:
        bpy.ops.preferences.addon_enable(module="scruple_blender")
        _report("addon_enable", True)
    except Exception as e:
        _report("addon_enable", False, str(e))
        traceback.print_exc()
        return 1

    # 2. Handlers registered — detect via HANDLER_TAG attribute the addon sets
    from bpy.app import handlers as H
    handler_names = {"render_complete", "render_write", "save_post"}
    HANDLER_TAG = "_scruple_blender_owned"
    for hname in handler_names:
        hlist = getattr(H, hname, None)
        if hlist is None:
            _report(f"handler_{hname}_exists", False, "attr missing on this Blender version")
            continue
        our = [h for h in hlist if getattr(h, HANDLER_TAG, False)]
        _report(f"handler_{hname}_registered", len(our) >= 1,
                f"({len(our)}/{len(hlist)} handlers tagged by scruple_blender)")

    # 3. Types registered — use actual class names
    _ = None
    expected_operators = [
        "scruple.auth_start",
        "scruple.witness_now",
        "scruple.checkpoint",
        "scruple.c2pa_sign",
        "scruple.chain_lock",
        "scruple.open_receipt",
        "scruple.payment_setup",
        "scruple.resume_payment",
        "scruple.witness_export",
        # WO-B5's dashboard operators.
        "scruple.refresh_config",
        "scruple.refresh_projects",
        "scruple.select_project",
        "scruple.archive_project",
        "scruple.select_capture",
        "scruple.clear_error",
    ]
    for op_id in expected_operators:
        module_name, op_name = op_id.split(".")
        found = hasattr(getattr(bpy.ops, module_name, None), op_name)
        _report(f"operator_{op_id}", found)

    # 4. Panel classes registered as bpy.types
    # WO-B5 made this a parent and five sub-panels. A sub-panel whose
    # `bl_parent_id` does not resolve registers WITHOUT error and is
    # silently absent from the N-panel, so each is checked by name.
    expected_panels = [
        "SCRUPLE_PT_main",
        "SCRUPLE_PT_projects",
        "SCRUPLE_PT_edits",
        "SCRUPLE_PT_tracker",
        "SCRUPLE_PT_receipt",
        "SCRUPLE_PT_locks",
    ]
    for cls in expected_panels:
        found = hasattr(bpy.types, cls)
        _report(f"panel_{cls}", found)

    # 5. Preferences accessible
    try:
        prefs = bpy.context.preferences.addons["scruple_blender"].preferences
        _report("preferences_readable", True,
                f"base_url={getattr(prefs, 'base_url', '?')}")
    except Exception as e:
        _report("preferences_readable", False, str(e))

    # 6. Trigger a minimal render to exercise the render_complete callback path
    try:
        import tempfile
        outdir = tempfile.mkdtemp(prefix="scruple_smoke_")
        outpath = os.path.join(outdir, "smoke_")
        bpy.context.scene.render.filepath = outpath
        bpy.context.scene.render.image_settings.file_format = "PNG"
        bpy.context.scene.render.resolution_x = 32
        bpy.context.scene.render.resolution_y = 32
        bpy.context.scene.render.use_persistent_data = False
        bpy.ops.render.render(write_still=True)
        rendered = [f for f in os.listdir(outdir) if f.startswith("smoke_")]
        _report("render_completes", len(rendered) >= 1,
                f"({len(rendered)} file(s) written)")
    except Exception as e:
        _report("render_completes", False, str(e))
        traceback.print_exc()

    # 7. Disable cleanly
    try:
        bpy.ops.preferences.addon_disable(module="scruple_blender")
        _report("addon_disable", True)
    except Exception as e:
        _report("addon_disable", False, str(e))

    print("---")
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} — {FAILURES}")
        return 1
    print("ALL SMOKE CHECKS PASSED")
    return 0


sys.exit(main())
