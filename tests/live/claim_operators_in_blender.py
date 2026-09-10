"""WO-G5 — does the add-on still register, with the two new operators on it?"""
import json, os, sys, traceback
out = {"ok": False}
try:
    import bpy
    src = os.environ["SCRUPLE_BLENDER_SRC"]
    sys.path.insert(0, os.path.dirname(src))
    sys.path.insert(0, src)
    sys.path.insert(0, os.path.join(src, "vendor"))
    # The add-on's directory is `scruple-blender`, which is not an importable
    # name. Blender installs it AS `scruple_blender`; here it is loaded by path
    # so the gate tests the source tree rather than an installed copy.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "scruple_blender", os.path.join(src, "__init__.py"),
        submodule_search_locations=[src])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["scruple_blender"] = mod
    spec.loader.exec_module(mod)
    mod.register()
    ops = [o for o in dir(bpy.ops.scruple) if not o.startswith("_")]
    out["operators"] = sorted(ops)
    out["has_baseline_addons"] = "baseline_addons" in ops
    out["has_check_claim"] = "check_claim" in ops
    # and they RUN, not merely exist
    os.environ["SCRUPLE_ADDON_BASELINE_PATH"] = os.environ["SCRUPLE_G5_BASELINE"]
    out["baseline_result"] = list(bpy.ops.scruple.baseline_addons())
    out["baseline_written"] = os.path.exists(os.environ["SCRUPLE_G5_BASELINE"])
    out["check_result"] = list(bpy.ops.scruple.check_claim())
    mod.unregister()
    out["unregistered"] = True
    out["ok"] = True
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"
    out["trace"] = traceback.format_exc().splitlines()[-10:]
print("<<<R>>>" + json.dumps(out) + "<<<E>>>")
