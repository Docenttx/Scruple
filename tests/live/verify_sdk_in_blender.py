"""WO-B2, verified inside Blender rather than inside pytest.

  blender --background --factory-startup --python tests/live/verify_sdk_in_blender.py

Writes its findings to $SCRUPLE_B2_BASE/in_blender_import.json and
prints them. Exit code is non-zero if any check failed.

Installs the BUILT ZIP into a scratch addons directory, imports it the
way Blender does, and checks the things the mock-bpy suite cannot: that
the vendored SDK imports under Blender's own interpreter, that MIME
resolves from real bpy's own format enum, that the real handlers install
and uninstall against real bpy.app.handlers, and that a real Cycles
render's bytes hash to the content_hash the SDK's capture() produces.
"""
import hashlib, json, os, sys, traceback, zipfile

BASE = os.environ.get("SCRUPLE_B2_BASE", "/mnt/corpus/scruple-blender-l2/b2")
OUT = os.path.join(BASE, "in_blender_import.json")
ZIP = os.environ.get("SCRUPLE_B2_ZIP", "/data/scruple-blender/dist/scruple-blender-0.1.0.zip")
DEST = os.path.join(BASE, "addons")

report = {"python": sys.version.split()[0]}
import bpy
report["blender"] = ".".join(str(v) for v in bpy.app.version)

os.makedirs(DEST, exist_ok=True)
with zipfile.ZipFile(ZIP) as z:
    z.extractall(DEST)
sys.path.insert(0, DEST)

try:
    import scruple_blender                      # runs the addon's sys.path setup
    import adapter                              # top-level, as the addon's own imports resolve it
    from adapter import scene as a_scene, sdk as a_sdk, flow as a_flow
    import scruple_host_sdk, scruple_api
    from scruple_host_sdk import capture as sdk_capture

    report["sdk_file"] = scruple_host_sdk.__file__
    report["sdk_is_vendored"] = a_sdk.sdk_is_vendored()
    report["api_file"] = scruple_api.__file__
    report["vendor_commit"] = a_sdk.vendored_sdk_info().get("source_commit", "")[:12]
    report["integration_version"] = a_sdk.integration_version()

    c = a_sdk.new_client(base_url="http://127.0.0.1:9", api_key=None, cache_dir=os.path.join(BASE, "home"))
    report["client_class"] = f"{type(c).__module__}.{type(c).__name__}"
    report["queue_path"] = c.queue.path
    report["queue_file_created"] = os.path.exists(c.queue.path)

    # --- a real render, in real Blender -------------------------------
    png = os.path.join(BASE, "render.png")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 4
    scene.render.resolution_x, scene.render.resolution_y = 160, 120
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = png[:-4]           # Blender appends .png
    bpy.ops.render.render(write_still=True)
    report["render_exists"] = os.path.exists(png)
    report["render_bytes"] = os.path.getsize(png) if os.path.exists(png) else 0

    resolved = a_scene.resolved_render_output(scene)
    report["resolved_render_output"] = resolved
    report["resolved_matches_disk"] = os.path.exists(resolved)

    report["mime_from_blenders_own_enum"] = a_scene.mime_for_render(scene)
    scene.render.image_settings.file_format = "OPEN_EXR"
    report["mime_exr"] = a_scene.mime_for_render(scene)
    scene.render.image_settings.file_format = "PNG"

    payload = sdk_capture.capture(resolved, mime=a_scene.mime_for_render(scene), kind="render",
                                  workflow=a_scene.build_render_workflow(
                                      filename=os.path.basename(resolved),
                                      scene_name=scene.name,
                                      render_engine=scene.render.engine,
                                      resolution=(scene.render.resolution_x, scene.render.resolution_y),
                                      samples=4, camera=getattr(scene.camera, "name", None),
                                      frame=scene.frame_current, trigger="headless"))
    on_disk = hashlib.sha256(open(resolved, "rb").read()).hexdigest()
    report["content_hash"] = payload["content_hash"]
    report["sha256_of_bytes_on_disk"] = on_disk
    report["content_hash_matches_bytes"] = payload["content_hash"] == on_disk
    report["declared_mime_in_payload"] = payload["mime"]
    report["workflow_engine"] = payload["workflow"]["engine"]

    # --- a real .blend save --------------------------------------------
    blend = os.path.join(BASE, "scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    report["blend_exists"] = os.path.exists(blend)
    blend_payload = sdk_capture.capture(blend, mime=a_scene.BLEND_MIME, kind="save")
    report["blend_mime"] = blend_payload["mime"]
    report["blend_hash_matches"] = blend_payload["content_hash"] == hashlib.sha256(open(blend, "rb").read()).hexdigest()

    # --- register against real bpy --------------------------------------
    scruple_blender.register()
    report["handlers_installed"] = sum(
        1 for h in bpy.app.handlers.render_complete if getattr(h, "_scruple_blender_owned", False))
    report["operator_witness_now_registered"] = hasattr(bpy.ops.scruple, "witness_now")
    report["operator_chain_lock_registered"] = hasattr(bpy.ops.scruple, "chain_lock")
    scruple_blender.unregister()
    report["handlers_after_unregister"] = sum(
        1 for h in bpy.app.handlers.render_complete if getattr(h, "_scruple_blender_owned", False))

    # --- and the refusal, in real Blender --------------------------------
    scene.render.image_settings.file_format = "PNG"
    try:
        a_scene.mime_for_export("other", "/tmp/x.xyz")
        report["unknown_export_refused"] = False
    except Exception as e:
        report["unknown_export_refused"] = type(e).__name__

    report["ok"] = True
except Exception as e:
    report["ok"] = False
    report["error"] = f"{type(e).__name__}: {e}"
    report["traceback"] = traceback.format_exc()

with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print("REPORT " + json.dumps(report, indent=2))

FAILED = [k for k, v in report.items() if k.endswith(("_matches", "_matches_bytes",
          "_matches_disk", "_is_vendored", "_exists", "_created", "_registered")) and v is False]
if not report.get("ok") or FAILED:
    print("FAILED CHECKS: " + ", ".join(FAILED) if FAILED else "FAILED")
    sys.exit(1)
