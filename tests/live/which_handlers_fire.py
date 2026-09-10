"""WO-G6 — does the add-on's save handler fire for edits made from a script?

The question every enumerated method reduces to: if someone changes a .blend
this way, does OUR handler run. Measured, per method, with the add-on actually
loaded — not reasoned about.
"""
import json, os, sys, traceback

out = {"fired": {}, "errors": {}}
SRC = os.environ["SCRUPLE_BLENDER_SRC"]
WORK = os.environ["G6_WORK"]

try:
    import bpy, importlib.util
    sys.path.insert(0, SRC); sys.path.insert(0, os.path.join(SRC, "vendor"))
    spec = importlib.util.spec_from_file_location(
        "scruple_blender", os.path.join(SRC, "__init__.py"), submodule_search_locations=[SRC])
    mod = importlib.util.module_from_spec(spec); sys.modules["scruple_blender"] = mod
    spec.loader.exec_module(mod)
    mod.register()

    # What did registering actually put on Blender's handler lists? This is the
    # ground truth for "would we notice" — every method below is only visible to
    # us through one of these.
    out["handlers_registered"] = {
        name: [getattr(f, "__name__", str(f)) for f in getattr(bpy.app.handlers, name)]
        for name in ("save_pre", "save_post", "load_post", "depsgraph_update_post", "undo_post")
        if hasattr(bpy.app.handlers, name)
    }

    # Count our own handlers firing by wrapping them.
    seen = {"save_post": 0, "load_post": 0, "depsgraph_update_post": 0}
    wrapped_count = 0
    for name in list(seen):
        lst = getattr(bpy.app.handlers, name, None)
        if lst is None: continue
        for i, f in enumerate(list(lst)):
            # ⚑ WRAP EVERY HANDLER ON THE LIST, not the ones whose name I guessed.
            # The first version filtered on "scruple" and the add-on's handlers are
            # `_on_save_post` in `adapter.handlers` — so it wrapped NOTHING and
            # reported zero fires, which reads exactly like "the handler did not
            # run". `wrapped_count` is the control: a run that wrapped nothing
            # measured nothing.
            if True:
                def make(orig, key):
                    def wrapped(*a, **k):
                        seen[key] += 1
                        return orig(*a, **k)
                    wrapped.__name__ = getattr(orig, "__name__", "wrapped")
                    return wrapped
                lst[i] = make(f, name)
                wrapped_count += 1

    out["wrapped_count"] = wrapped_count
    blend = os.path.join(WORK, "h.blend")

    # ── method 1 · an ordinary save from a script ────────────────────────────
    bpy.ops.mesh.primitive_cube_add()
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    out["fired"]["save_from_script"] = dict(seen)

    # ── method 2 · edit the scene, save again ────────────────────────────────
    before = dict(seen)
    bpy.ops.mesh.primitive_uv_sphere_add()
    bpy.ops.wm.save_mainfile()
    out["fired"]["edit_then_save"] = {k: seen[k] - before[k] for k in seen}

    # ── method 3 · write the .blend with NO save operator ────────────────────
    # `bpy.data.libraries.write` serialises datablocks straight to a file. It is
    # the documented way to write a partial .blend, and it is not a "save".
    before = dict(seen)
    partial = os.path.join(WORK, "partial.blend")
    try:
        bpy.data.libraries.write(partial, {bpy.data.objects[0]})
        out["fired"]["libraries_write"] = {k: seen[k] - before[k] for k in seen}
        out["libraries_write_produced_a_file"] = os.path.exists(partial)
    except Exception as e:
        out["errors"]["libraries_write"] = str(e)

    mod.unregister()
    out["ok"] = True
except Exception as e:
    out["ok"] = False
    out["error"] = f"{type(e).__name__}: {e}"
    out["trace"] = traceback.format_exc().splitlines()[-8:]

print("<<<H>>>" + json.dumps(out) + "<<<E>>>")
