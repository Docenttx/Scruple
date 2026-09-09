"""Run INSIDE Blender: enable the addon, set the scene up, announce a
generation, and report what actually happened as JSON.

WO-E4. Everything this prints is read back out of the running Blender or
off the filesystem after Blender wrote it. Nothing here asserts; the gate
does that. Nothing here reads a pixel — docs/DESIGN.md: llvmpipe returns a
blank frame, so the framebuffer is not evidence of anything.

  blender --background --python scripts/e4-blender-host.py -- \
      --host-dir DIR --prompt-id ID [--scene NAME] [--frame N]
      [--camera NAME] [--no-camera] [--declare-only]

⚑ SCRUPLE_COMFY_HOST_DIR MUST BE IN THE ENVIRONMENT BEFORE BLENDER STARTS.
The addon declares itself in `register()`, which Blender runs while it is
enabling the addon from saved preferences — before this script's first
line. Setting it here would be too late for the declaration and would
prove the wrong thing: what the gate must be able to rely on is that
ENABLING THE ADDON declares it, not that a script did.
"""

import json
import os
import sys

import bpy

MARK_OPEN = "<<<E4_BLENDER"
MARK_CLOSE = "E4_BLENDER>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"flags": set()}
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--no-camera", "--declare-only"):
            out["flags"].add(a[2:])
            i += 1
            continue
        out[a.lstrip("-")] = args[i + 1]
        i += 2
    return out


def addon_module():
    """The module name Blender itself uses, so a report can say whether the
    manifest path or the bl_info path loaded it (WO-E3's discriminator)."""
    for a in bpy.context.preferences.addons:
        if a.module.endswith("scruple_blender"):
            return a.module
    return None


def main():
    a = argv()
    host_dir = a.get("host-dir")
    report = {
        "blender_version": ".".join(str(x) for x in bpy.app.version),
        "host_dir_env": os.environ.get("SCRUPLE_COMFY_HOST_DIR"),
        "module": addon_module(),
        # WO-E3's discriminator: on 4.2+ the module Blender names is
        # `bl_ext.<repo>.<id>`, which only the manifest path produces.
        "loaded_via_manifest": (addon_module() or "").startswith("bl_ext."),
        "operators": sorted(
            n for n in dir(bpy.ops.scruple) if not n.startswith("_")
        ) if hasattr(bpy.ops, "scruple") else [],
    }

    # THE DECLARATION, WRITTEN BY register() BEFORE THIS SCRIPT RAN.
    decl_path = os.path.join(host_dir, "scruple-host.json") if host_dir else None
    report["declaration_path"] = decl_path
    report["declaration_exists"] = bool(decl_path and os.path.exists(decl_path))
    if report["declaration_exists"]:
        with open(decl_path, encoding="utf-8") as f:
            report["declaration"] = json.load(f)

    if "declare-only" in a["flags"]:
        emit(report)
        return

    scn = bpy.context.scene
    if a.get("scene"):
        scn.name = a["scene"]
    if a.get("frame"):
        scn.frame_current = int(a["frame"])
    if "no-camera" in a["flags"]:
        # A scene with no camera: the addon must decline rather than
        # announce that the camera was null.
        scn.camera = None
    elif a.get("camera"):
        scn.camera.name = a["camera"]

    # THE SCENE, AS BLENDER HOLDS IT, BEFORE ANY ANNOUNCEMENT IS WRITTEN.
    # The gate compares this against the leaf, so a field the addon
    # invented rather than read would show up as a difference here.
    report["scene_as_blender_holds_it"] = {
        "name": scn.name,
        "frame_current": scn.frame_current,
        "camera": getattr(scn.camera, "name", None),
        "engine": scn.render.engine,
        "resolution_x": scn.render.resolution_x,
        "resolution_y": scn.render.resolution_y,
        "resolution_percentage": scn.render.resolution_percentage,
        "file_format": scn.render.image_settings.file_format,
    }

    prompt_id = a.get("prompt-id", "")
    # ⚑ THE OPERATOR MAY NOT EXIST, and that is the whole point of the
    # before/after control: the addon at the commit before WO-E4 registers no
    # `scruple.host_announce`, so this must report ITS ABSENCE rather than
    # dying. A control that produces no report is INCONCLUSIVE, not red.
    if hasattr(bpy.ops.scruple, "host_announce"):
        try:
            status = sorted(bpy.ops.scruple.host_announce(prompt_id=prompt_id))
        except Exception as exc:  # noqa: BLE001 — reported, not swallowed
            status = ["RAISED: %s" % exc]
    else:
        status = ["NO_SUCH_OPERATOR"]
    report["announce_status"] = status
    ann_path = os.path.join(host_dir, "announce", f"{prompt_id}.json") if host_dir else None
    report["announce_path"] = ann_path
    report["announce_exists"] = bool(ann_path and os.path.exists(ann_path))
    if report["announce_exists"]:
        with open(ann_path, encoding="utf-8") as f:
            report["announcement"] = json.load(f)
    emit(report)


def emit(report):
    print(MARK_OPEN)
    print(json.dumps(report, indent=2, sort_keys=True))
    print(MARK_CLOSE)


try:
    main()
except Exception as exc:  # noqa: BLE001 — a crash must still produce a report
    import traceback
    emit({"error": str(exc), "traceback": traceback.format_exc()})
