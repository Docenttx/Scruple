"""WO-B5, driven inside real Blender against the scratch stack.

    blender --background --factory-startup --python this_file.py

WHY THIS EXISTS ALONGSIDE tests/test_dashboard.py.

The mock-bpy suite can prove what a region draws and when. It cannot
prove three things, and all three are ways this WO could ship broken:

  1. **The panel classes register.** `bl_parent_id`, `bl_options` and a
     `poll()` classmethod are validated by `bpy.utils.register_class`,
     not by a mock that stores class attributes. A sub-panel whose
     parent id is wrong is silently absent from the real N-panel.
  2. **The operator properties are declared.** `layout.operator(...)
     .project_id = 2` works against the mock whether or not
     `project_id` is a `bpy.props.IntProperty`, because the mock's
     OperatorProps takes any attribute. In Blender it raises. So every
     property the panel sets is exercised here through `bpy.ops`.
  3. **A project switch changes where a leaf lands.** The mock asserts
     `project_id` appears on the witness body. This asserts the row in
     the scratch app's `iterations` table carries it -- the observable,
     which is the only thing that settles the question.

Nothing here asserts; it writes `dashboard-phases.jsonl` and the driver
(`docs/canon/blender-l2/05-*`) grades it against the database.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time

ADDON = os.environ.get("SCRUPLE_B5_ADDON", "/data/scruple-blender")
if ADDON not in sys.path:
    sys.path.insert(0, ADDON)

import adapter  # noqa: E402  (puts vendor/ on sys.path)
from adapter import flow as _wf  # noqa: E402
from adapter import projects as _projects  # noqa: E402
from adapter import sdk as _sdk  # noqa: E402
from adapter import state as _state  # noqa: E402

import bpy  # noqa: E402

BASE = os.environ.get("SCRUPLE_B5_BASE", "/mnt/corpus/scruple-blender-l2/b5")
APP = os.environ.get("SCRUPLE_APP_URL", "http://127.0.0.1:3902")
KEY = os.environ.get("SCRUPLE_B5_API_KEY", "")
APP_DB = os.environ.get("SCRUPLE_SCRATCH_DB", "")
HOME = os.path.join(BASE, "home")
OUT = os.path.join(BASE, "dashboard-phases.jsonl")

#: The two projects the driver created on the scratch app.
PROJECT_A = int(os.environ.get("SCRUPLE_B5_PROJECT_A", "3"))
PROJECT_B = int(os.environ.get("SCRUPLE_B5_PROJECT_B", "4"))

os.makedirs(BASE, exist_ok=True)
os.makedirs(HOME, exist_ok=True)

PANEL_CLASSES = (
    "SCRUPLE_PT_main",
    "SCRUPLE_PT_projects",
    "SCRUPLE_PT_edits",
    "SCRUPLE_PT_tracker",
    "SCRUPLE_PT_receipt",
    "SCRUPLE_PT_locks",
)

DASHBOARD_OPERATORS = (
    "refresh_config",
    "refresh_projects",
    "select_project",
    "archive_project",
    "select_capture",
    "clear_error",
)


def emit(step, record):
    record["step"] = step
    record["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, default=str) + "\n")
    print(f"[B5:{step}] " + json.dumps(record, default=str)[:500])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def render(name, seed):
    """A real Cycles CPU render at 160x120, a different primitive per
    seed so two renders never hash the same."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    makers = [
        lambda: bpy.ops.mesh.primitive_torus_add(major_radius=1.5, minor_radius=0.5),
        lambda: bpy.ops.mesh.primitive_monkey_add(size=2.0),
        lambda: bpy.ops.mesh.primitive_cone_add(radius1=1.3, depth=2.4),
    ]
    makers[seed % len(makers)]()
    bpy.context.object.rotation_euler = (0.3 * seed, 0.2 * seed, 0.1 * seed)
    bpy.ops.object.camera_add(location=(0, -6, 2 + seed * 0.4), rotation=(1.2, 0, 0))
    scene.camera = bpy.context.object
    bpy.ops.object.light_add(type="POINT", location=(3, -3, 5))
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 4
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 160
    scene.render.resolution_y = 120
    scene.render.image_settings.file_format = "PNG"
    path = os.path.join(BASE, name)
    scene.render.filepath = path[: -len(".png")] if path.endswith(".png") else path
    bpy.ops.render.render(write_still=True)
    written = scene.render.filepath + ".png"
    if not os.path.exists(written) and os.path.exists(path):
        written = path
    return scene, written


def app_row(content_hash):
    """The row the scratch app wrote, by content hash. The observable."""
    if not APP_DB or not content_hash:
        return None
    conn = sqlite3.connect(APP_DB)
    row = conn.execute(
        "SELECT id, project_id, run_sequence, output_hash, witnessed "
        "FROM iterations WHERE output_hash = ? ORDER BY id DESC LIMIT 1",
        (content_hash,),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return {
        "leaf_id": row[0], "project_id": row[1], "run_sequence": row[2],
        "output_hash": row[3], "witnessed": row[4],
    }


def main():
    # 1. The addon registers, in the real Blender that validates it.
    register_error = None
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "scruple_blender_entry", os.path.join(ADDON, "__init__.py")
    )
    entry = importlib.util.module_from_spec(spec)
    sys.modules["scruple_blender_entry"] = entry
    try:
        spec.loader.exec_module(entry)
        entry.register()
    except Exception as e:
        register_error = f"{type(e).__name__}: {e}"

    emit("register", {
        "register_error": register_error,
        "panels_on_bpy_types": {c: hasattr(bpy.types, c) for c in PANEL_CLASSES},
        "operators_on_bpy_ops": {
            name: hasattr(bpy.ops.scruple, name) for name in DASHBOARD_OPERATORS
        },
        "parent_ids": {
            c: getattr(getattr(bpy.types, c, None), "bl_parent_id", None) for c in PANEL_CLASSES
        },
    })

    # 2. A live client, and the project list off the real app.
    #
    # The key goes into the SDK's auth cache as well as onto the Client:
    # `preferences.is_authed()` reads the cache, and the panel's model is
    # built from `is_authed()`, not from whether a Client happens to
    # exist. The first run of this harness set the key on the Client only
    # and the model reported `signed_in: false` while witnessing
    # successfully -- which is the model telling the truth about a
    # half-signed-in session, and is not a state a real user can be in.
    from scruple_host_sdk import auth as _auth

    # Into the scratch tree, never into ~/.scruple: this harness must not
    # be able to overwrite a real key on the box it runs on.
    _auth.CACHE_DIR = os.path.join(BASE, "auth")
    _auth.save_cached(_sdk.HOST, api_key=KEY, base_url=APP)
    client = _sdk.new_client(base_url=APP, api_key=KEY, cache_dir=HOME)
    _sdk.set_client(client)
    attached = _wf.ensure_attached(client)

    index = _projects.refresh(client)
    emit("projects", {
        "attached": attached,
        "baseline_ref": client.state.baseline_ref,
        "connection": index.connection,
        "error": index.error,
        "live": [{"id": p.id, "name": p.name, "leaves": p.iteration_count} for p in index.live],
        "server_active_id": index.server_active_id,
    })

    # 3. Every sub-panel's poll(), evaluated in real Blender. This is the
    #    model built against real bpy -- bpy.data.filepath, the real
    #    preferences object, the real vendored SDK manifest.
    def polls():
        return {
            c: bool(getattr(bpy.types, c).poll(bpy.context))
            for c in PANEL_CLASSES if c != "SCRUPLE_PT_main"
        }

    emit("poll_before_capture", {"polls": polls()})

    # 4. Switch to project A through bpy.ops -- which is what proves the
    #    IntProperty is declared -- render, witness.
    results = []
    for label, pid, seed in (("A", PROJECT_A, 0), ("B", PROJECT_B, 1)):
        op_result = bpy.ops.scruple.select_project(project_id=pid)
        scene, path = render(f"b5-{label.lower()}.png", seed)
        outcome = _wf.witness_render(client, scene, trigger="render_complete")
        rec = _state.last_assurance()
        content_hash = rec.content_hash if rec else None
        results.append({
            "label": label,
            "requested_project_id": pid,
            "select_op_result": list(op_result),
            "active_project_id": _state.get().active_project_id,
            "active_project_name": _state.get().active_project_name,
            "file": os.path.basename(path),
            "bytes": os.path.getsize(path) if os.path.exists(path) else None,
            "sha256_on_disk": sha256_file(path) if os.path.exists(path) else None,
            "recorded_content_hash": content_hash,
            "leaf_id": outcome.leaf_id if outcome else None,
            "witnessed": bool(outcome and outcome.witnessed),
            "state": rec.state if rec else None,
            "assurance_tier": rec.assurance_tier if rec else None,
            "app_row": app_row(content_hash),
        })
    emit("switch_and_capture", {"captures": results})

    # 5. The other dashboard operators, through bpy.ops, so every
    #    property the panel sets is exercised against real Blender.
    from adapter import assurance as _assurance

    last = _state.last_assurance()
    key = _assurance.capture_key(last) if last else ""
    op_results = {
        "select_capture": list(bpy.ops.scruple.select_capture(capture_key=key)),
        "clear_error": list(bpy.ops.scruple.clear_error()),
        "refresh_config": list(bpy.ops.scruple.refresh_config()),
        "refresh_projects": list(bpy.ops.scruple.refresh_projects()),
    }
    selected = _state.selected_capture()
    emit("operators", {
        "results": op_results,
        "selected_capture_key": _state.get().selected_capture_key,
        "selected_leaf_id": getattr(selected, "leaf_id", None),
        "last_error_after_clear": _state.get().last_error,
    })

    # 6. The model, built inside Blender, and every region's show_*.
    from panels import model as _model

    m = _model.build()
    emit("model", {
        "signed_in": m.signed_in,
        "document_name": m.document_name,
        "connection": m.connection,
        "connection_label": m.connection_label,
        "projects": [p.name for p in m.projects],
        "active_project_id": m.active_project_id,
        "captures": len(m.captures),
        "capture_counts": m.capture_counts,
        "queue_depth": m.queue_depth,
        "payment_ready": m.payment_ready,
        "payment_checked": m.payment_checked,
        "payment_error": m.payment_error,
        "lock_actions": [
            {"action": a.action, "price": a.price, "available": a.available, "reason": a.reason}
            for a in m.lock_actions
        ],
        "lock_state_line": m.lock_state_line,
        "show": {
            name: bool(getattr(m, f"show_{name}"))
            for name in (
                "signin", "projects", "offline", "queue", "tracker",
                "receipt", "locks", "payment_setup", "reconciliation", "error",
            )
        },
        "polls_after_capture": polls(),
    })

    # 7. The edits region reads the server's own history of the project
    #    the last capture went into.
    detail = _projects.refresh_detail(client)
    emit("edits", {
        "project_id": detail.project_id if detail else None,
        "error": detail.error if detail else None,
        "iterations": [
            {"run_sequence": it.get("run_sequence"), "leaf_hash": (it.get("leaf_hash") or "")[:16],
             "witnessed": it.get("witnessed")}
            for it in (detail.iterations if detail else [])
        ],
    })

    try:
        entry.unregister()
    except Exception as e:
        emit("unregister", {"error": f"{type(e).__name__}: {e}"})
    else:
        emit("unregister", {"error": None})


main()
