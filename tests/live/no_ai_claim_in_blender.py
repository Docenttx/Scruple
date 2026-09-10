"""WO-G5 live probe — §4 demonstrated inside a real Blender.

Runs headless. Enumerates the add-on set, derives a claim, INSTALLS ANOTHER
ADD-ON, enumerates again, and shows the claim being withdrawn for that span.

Prints one JSON document between markers so a gate can read it without parsing
Blender's own chatter.
"""
import json
import os
import sys
import traceback

ROOT = os.environ["SCRUPLE_BLENDER_SRC"]
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "vendor"))

out = {"ok": False}
try:
    import bpy
    import addon_utils

    from adapter import host_addons as ha
    from adapter import source_type as st
    from adapter import scene as sc

    # ── 1 · the baseline: what add-ons is this Blender running ───────────────
    baseline = ha.enumerate_addons()
    out["baseline"] = {
        "count": baseline["count"],
        "third_party_count": baseline["third_party_count"],
        "unreadable_count": baseline["unreadable_count"],
        "digest": ha.document_hash(baseline),
        "modules": [m["module"] for m in baseline["addons"]],
    }

    # ── 2 · put something INTO the document, so there is an import to enumerate
    # A texture loaded from disk is the ordinary case: an artist brings in an
    # image. Whether it is generative is exactly what the record has to answer.
    tex = os.environ["SCRUPLE_G5_TEXTURE"]
    img = bpy.data.images.load(tex)
    img.pack()   # the copy THIS DOCUMENT contains, which is what gets hashed

    # ── what entered the document ────────────────────────────────────────────
    imported = sc.imported_datablocks()
    out["imported"] = None if imported is None else {
        "source": imported.get("source"),
        "origin_observed": imported.get("origin_observed"),
        "count": len(imported.get("datablocks") or []),
        "digests": [e.get("digest") for e in (imported.get("datablocks") or [])],
    }

    claim_before = st.derive(imported=imported, addons=baseline)
    out["claim_before"] = dict(claim_before)

    # ── 3 · install another add-on · Standard §4 ─────────────────────────────
    # A minimal, entirely inert add-on. It does nothing — which is the point:
    # what §4 witnesses is that the SET changed, not what the new member does.
    # Judging an add-on by its behaviour is a blocklist, and a blocklist is one
    # rename away from wrong.
    extra_dir = os.environ["SCRUPLE_G5_EXTRA_ADDON_DIR"]
    os.makedirs(extra_dir, exist_ok=True)
    mod_name = "g5_probe_addon"
    with open(os.path.join(extra_dir, mod_name + ".py"), "w") as f:
        f.write(
            'bl_info = {"name": "G5 Probe Addon", "blender": (4, 0, 0), "version": (0, 1, 0),\n'
            '           "category": "Development"}\n'
            "def register():\n    pass\n\ndef unregister():\n    pass\n"
        )
    prefs = bpy.context.preferences
    sp = prefs.filepaths.script_directories
    try:
        item = sp.new()
        item.name = "g5"
        item.directory = os.path.dirname(extra_dir)
    except Exception:
        pass
    bpy.utils.refresh_script_paths()
    addon_utils.modules_refresh()
    ok, _ = addon_utils.check(mod_name)
    if not ok:
        addon_utils.enable(mod_name, default_set=True, persistent=False)
    out["installed"] = mod_name in {m.__name__ for m in addon_utils.modules()}

    # ── 4 · enumerate again, and compare ────────────────────────────────────
    after = ha.enumerate_addons()
    change = ha.changed(baseline, after)
    out["after"] = {
        "count": after["count"],
        "digest": ha.document_hash(after),
        "modules": [m["module"] for m in after["addons"]],
    }
    out["change"] = change
    out["digest_moved"] = out["baseline"]["digest"] != out["after"]["digest"]

    # ── 5 · the claim, over a span in which the plugin set changed ──────────
    claim_after = st.derive(imported=imported, addons=after, addon_change=change)
    out["claim_after"] = dict(claim_after)

    # ── 6 · the same scene, with that texture DECLARED as generative ────────
    # Not a refusal: declared generative material is a fact, and the honest
    # answer is the composite type. This is what makes the module usable inside
    # Studio as well as outside it.
    digests = [e.get("digest") for e in (imported.get("datablocks") or []) if e.get("digest")]
    out["claim_composite"] = dict(
        st.derive(imported=imported, addons=baseline, ai_origin_digests=digests)
    )

    out["ok"] = True
except Exception as e:  # a probe that died must not look like a probe that passed
    out["error"] = f"{type(e).__name__}: {e}"
    out["trace"] = traceback.format_exc().splitlines()[-8:]

print("<<<G5>>>" + json.dumps(out) + "<<<END>>>")
