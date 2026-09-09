"""Run INSIDE Blender: point a THIRD-PARTY bridge at an address, generate, and
report what happened as JSON.

WO-E6. This is the far end of the product claim in `docs/BLENDER.md`: a bridge
inside Blender is pointed at the capture gate instead of at ComfyUI, the user
generates, and one leaf carries the graph, the model fingerprints AND the scene.

    blender --background --python scripts/e6-blender-generate.py -- \
        --target URL --host-dir DIR --workflow FILE --base-folder DIR \
        --report FILE [--scene NAME] [--frame N] [--camera NAME]
        [--announce off] [--phantom-scene NAME --phantom-prompt-id ID]

⚑ WHAT THIS FILE IS AND IS NOT. It is the eleven lines a Blender user's hand
would be: set the server address, pick a workflow, press Generate. It is NOT a
reimplementation of a bridge and it is not a patch to one — every network call
in this run is made by `comfyui_blender`'s own code, from a release zip
downloaded unmodified (`docs/WO-E6.md` records the digest). This script never
opens a socket.

⚑ AND IT IS NOT THE SCRUPLE ADDON EITHER. The scene facts are written by
`bpy.ops.scruple.host_announce`, which is the addon's operator over its own
`adapter/host_hook.py`. This script chooses WHEN to call it and nothing else —
see finding E6-1 for why that "when" is a race the host cannot currently
remove: this bridge does not send ComfyUI a `prompt_id`, so the id only exists
after `/prompt` has been answered.

Nothing here asserts. The gate does that, from the filesystem and from sqlite.
Nothing here reads a pixel.
"""

import hashlib
import json
import os
import sys
import time

import bpy

MARK_OPEN = "<<<E6_BLENDER"
MARK_CLOSE = "E6_BLENDER>>>"

BRIDGE = "comfyui_blender"          # the third-party addon, by its own module name
OURS = "scruple_blender"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {}
    i = 0
    while i < len(args):
        out[args[i].lstrip("-")] = args[i + 1]
        i += 2
    return out


def module_of(suffix):
    for a in bpy.context.preferences.addons:
        if a.module.endswith(suffix):
            return a.module
    return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot(folder):
    out = {}
    for root, _dirs, files in os.walk(folder):
        for name in files:
            p = os.path.join(root, name)
            try:
                out[p] = os.path.getsize(p)
            except OSError:
                pass
    return out


def main():
    a = argv()
    report = {
        "blender_version": ".".join(str(x) for x in bpy.app.version),
        "host_dir_env": os.environ.get("SCRUPLE_COMFY_HOST_DIR"),
        "scruple_module": module_of(OURS),
        "bridge_module": module_of(BRIDGE),
        "enabled_addons": sorted(x.module for x in bpy.context.preferences.addons),
        "target": a.get("target"),
        "announce": a.get("announce", "on"),
    }
    if report["bridge_module"] is None:
        report["error"] = "the bridge addon is not enabled in this profile"
        emit(report, a)
        return

    prefs = bpy.context.preferences.addons[BRIDGE].preferences

    # ── the bridge's own preferences. THE WHOLE INTEGRATION, LEVEL 1 ────────
    # One string. `docs/BLENDER.md`: "point it at the gate and the bridge is
    # captured with no code from us". The bridge's own update callback cleans
    # the value up and drops any live connection, which is why the address is
    # read back afterwards rather than assumed.
    prefs.base_folder = a["base-folder"]
    prefs.server_address = a["target"]
    report["bridge_prefs"] = {
        "server_address": prefs.server_address,
        "base_folder": prefs.base_folder,
        "outputs_folder": prefs.outputs_folder,
        "workflows_folder": prefs.workflows_folder,
        "client_id": prefs.client_id,
    }

    # ── the scene, set up as a user would have it ───────────────────────────
    scn = bpy.context.scene
    if a.get("scene"):
        scn.name = a["scene"]
    if a.get("frame"):
        scn.frame_current = int(a["frame"])
    if a.get("camera") and scn.camera is not None:
        scn.camera.name = a["camera"]
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

    # ── the workflow, imported through the BRIDGE'S OWN operator ────────────
    # `comfy.import_workflow` is what the add-on's File menu calls. The file it
    # is handed is an API-format export, which is the format its README asks
    # for; nothing here writes into the add-on's folders directly.
    report["import_status"] = sorted(
        bpy.ops.comfy.import_workflow(filepath=a["workflow"], invoke_default=False))
    imported = os.path.basename(a["workflow"])
    prefs.workflow = imported
    report["workflow_selected"] = prefs.workflow

    outputs = prefs.outputs_folder
    before = snapshot(outputs)

    # ── connect, and generate ───────────────────────────────────────────────
    # The WebSocket is how this add-on learns a generation finished and where
    # its `download_file` is called from. It goes to the same address as
    # `/prompt`, so a gate that is the address gets both.
    report["connect_status"] = sorted(bpy.ops.comfy.connect_to_server())
    report["connection_status"] = bool(prefs.connection_status)

    t_submit = time.time()
    report["run_status"] = sorted(bpy.ops.comfy.run_workflow())
    t_submitted = time.time()

    # ⚑ THE PROMPT ID EXISTS ONLY NOW. The bridge does not send one, so
    # ComfyUI minted it and the bridge read it off the response into its own
    # collection. Finding E6-1: the announcement therefore cannot be written
    # before the submission, and the window it has is however long the
    # generation takes.
    prompt_id = prefs.prompts_collection[-1].name if len(prefs.prompts_collection) else None
    report["prompt_id"] = prompt_id
    report["submit_seconds"] = round(t_submitted - t_submit, 3)

    if a.get("announce", "on") != "off" and prompt_id:
        t0 = time.time()
        try:
            status = sorted(bpy.ops.scruple.host_announce(prompt_id=prompt_id))
        except Exception as exc:                      # noqa: BLE001 — reported
            status = ["RAISED: %s" % exc]
        report["announce_status"] = status
        report["announce_seconds"] = round(time.time() - t0, 3)
        report["announced_at"] = time.time()
    else:
        report["announce_status"] = ["SKIPPED"]

    # ⚑ THE CONTROL OF WO-E6's THIRD LIMB, when asked for: an announcement
    # naming a scene that no generation produced, written under an id nothing
    # was submitted with. The gate must not let it reach a leaf.
    if a.get("phantom-scene"):
        # The id it is announced under is the whole control: `--phantom-under-
        # real-id` puts the SAME document on the id the bridge really
        # submitted, and then it does reach the leaf. One difference, one
        # outcome, nothing else changed.
        under = prompt_id if a.get("phantom-under-real-id") else a["phantom-prompt-id"]
        scn.name = a["phantom-scene"]
        try:
            report["phantom_announce_status"] = sorted(
                bpy.ops.scruple.host_announce(prompt_id=under))
        except Exception as exc:                      # noqa: BLE001
            report["phantom_announce_status"] = ["RAISED: %s" % exc]
        report["phantom_scene"] = a["phantom-scene"]
        report["phantom_prompt_id"] = a["phantom-prompt-id"]
        report["phantom_announced_under"] = under
        scn.name = report["scene_as_blender_holds_it"]["name"]

    # ── wait for the BRIDGE to have downloaded the artifact ─────────────────
    # The observable is a file in the add-on's own outputs folder, put there by
    # its `download_file` on its WebSocket listener thread — never a log line,
    # and never this script fetching anything.
    deadline = time.time() + float(a.get("timeout", "180"))
    new = {}
    while time.time() < deadline:
        after = snapshot(outputs)
        new = {p: s for p, s in after.items() if p not in before and s > 0}
        if new:
            # One settle pass, so a file caught mid-write is not hashed.
            time.sleep(0.5)
            sizes = {p: os.path.getsize(p) for p in new}
            if sizes == {p: new[p] for p in new}:
                break
        time.sleep(0.25)
    report["downloaded_at"] = time.time()
    report["download_seconds"] = round(report["downloaded_at"] - t_submitted, 3)
    report["outputs_folder"] = outputs
    report["downloads"] = [
        {"path": p, "bytes": os.path.getsize(p), "sha256": sha256(p)}
        for p in sorted(new)
    ]
    if "announced_at" in report:
        # The margin finding E6-1 is about, MEASURED rather than argued.
        report["announce_margin_seconds"] = round(
            report["downloaded_at"] - report["announced_at"], 3)

    report["queue_after"] = prefs.queue
    emit(report, a)


def emit(report, a=None):
    body = json.dumps(report, indent=2, sort_keys=True)
    if a and a.get("report"):
        with open(a["report"], "w", encoding="utf-8") as f:
            f.write(body)
    print(MARK_OPEN)
    print(body)
    print(MARK_CLOSE)


try:
    main()
except Exception as exc:                              # noqa: BLE001
    import traceback
    a = argv()
    emit({"error": str(exc), "traceback": traceback.format_exc()}, a)
