"""WO-B4, driven inside real Blender against the scratch stack.

    blender --background --factory-startup --python this_file.py

Phases, selected by `SCRUPLE_B4_PHASE`, each a SEPARATE Blender process
because that is the point: the queue, the ledger and the baseline cache
are files, and they are the only things that survive between them. A test
that stopped and restarted a server inside one process would prove the
queue works across a socket error; running the phases as separate
processes proves it works across a Blender restart, which is the case a
user actually hits.

    attach        app up      -- establish the baseline, cache it
    capture       app DOWN    -- render N frames, witness them, spool them
    settle        app up      -- drain, reconcile, confirm every leaf
    drop          app DOWN    -- render N more and spool them
    settle_drop   app up      -- delete ONE queue line, reconcile, see the gap
    witness_down  app up, witness server DOWN

Every phase appends to `$SCRUPLE_B4_BASE/phases.jsonl`. Nothing here
asserts; the driver reads the file and grades.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time

ADDON = os.environ.get("SCRUPLE_B4_ADDON", "/data/scruple-blender")
if ADDON not in sys.path:
    sys.path.insert(0, ADDON)

import adapter  # noqa: E402  (puts vendor/ on sys.path)
from adapter import flow as _wf  # noqa: E402
from adapter import ledger as _ledger  # noqa: E402
from adapter import reconcile as _reconcile  # noqa: E402
from adapter import sdk as _sdk  # noqa: E402
from adapter import state as _state  # noqa: E402

import bpy  # noqa: E402

PHASE = os.environ.get("SCRUPLE_B4_PHASE", "attach")
BASE = os.environ.get("SCRUPLE_B4_BASE", "/mnt/corpus/scruple-blender-l2/b4")
APP = os.environ.get("SCRUPLE_APP_URL", "http://127.0.0.1:3902")
KEY = os.environ.get("SCRUPLE_B4_API_KEY", "")
APP_DB = os.environ.get("SCRUPLE_SCRATCH_DB", "")
HOME = os.path.join(BASE, "home")
OUT = os.path.join(BASE, "phases.jsonl")

os.makedirs(BASE, exist_ok=True)
os.makedirs(HOME, exist_ok=True)


def emit(record):
    record["phase"] = PHASE
    record["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, default=str) + "\n")
    print(f"[B4:{PHASE}] " + json.dumps(record, default=str)[:400])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def client():
    c = _sdk.new_client(base_url=APP, api_key=KEY, cache_dir=HOME)
    _sdk.set_client(c)
    return c


# ---- real Blender content ----------------------------------------------


def render(name, seed):
    """A real Cycles CPU render at 160x120. Small on purpose -- the WO
    needs real bytes, not a long wait."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # A DIFFERENT primitive per seed, not a parameter tweak: two renders
    # that hash the same would make a dropped queue entry undetectable,
    # because verify() would find the twin's hash and call it settled.
    # Observed, not guessed -- an earlier version varied only radius and
    # camera height and produced two byte-identical PNGs.
    makers = [
        lambda: bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.4),
        lambda: bpy.ops.mesh.primitive_torus_add(major_radius=1.5, minor_radius=0.5),
        lambda: bpy.ops.mesh.primitive_cone_add(radius1=1.3, depth=2.4),
        lambda: bpy.ops.mesh.primitive_monkey_add(size=2.0),
        lambda: bpy.ops.mesh.primitive_cylinder_add(radius=1.1, depth=2.0),
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


# ---- phases -------------------------------------------------------------


def phase_attach():
    c = client()
    ok = _wf.ensure_attached(c)
    from adapter import baseline_cache as _bc

    cached = _bc.load(c)
    emit({
        "attached": ok,
        "baseline_ref": c.state.baseline_ref,
        "tamper_surface_hash": c.state.tamper_surface_hash,
        "cache_written": cached is not None,
        "cached_baseline_ref": cached.baseline_ref if cached else None,
        "queue_path": c.queue.path,
        "ledger_path": _ledger.ledger_path_for(c.queue.path),
    })


def phase_capture(n=3, prefix="off"):
    """Renders while the app is unreachable. Every one must spool."""
    c = client()
    results = []
    for i in range(n):
        scene, path = render(f"{prefix}{i}.png", i)
        outcome = _wf.witness_render(c, scene, trigger="render_complete")
        rec = _state.last_assurance()
        results.append({
            "file": os.path.basename(path),
            "bytes": os.path.getsize(path) if os.path.exists(path) else None,
            "sha256_on_disk": sha256_file(path) if os.path.exists(path) else None,
            "queued": bool(outcome and outcome.queued),
            "witnessed": bool(outcome and outcome.witnessed),
            "leaf_id": outcome.leaf_id if outcome else None,
            "state": rec.state if rec else None,
            "recorded_content_hash": rec.content_hash if rec else None,
            "error": (outcome.error if outcome else None),
        })
    led = _ledger.get(c)
    emit({
        "baseline_ref": c.state.baseline_ref,
        "captures": results,
        "queue_depth": c.queue_depth,
        "ledger_lines": [
            {k: l.get(k) for k in ("seq", "state", "content_hash", "filename", "queue_id")}
            for l in led.load_all()
        ],
    })


def _app_rows(hashes):
    if not APP_DB or not hashes:
        return []
    conn = sqlite3.connect(APP_DB)
    marks = ",".join("?" for _ in hashes)
    rows = conn.execute(
        f"SELECT id, output_hash, output_content_type, witnessed, leaf_scheme, "
        f"canonicalization_profile FROM iterations WHERE output_hash IN ({marks})",
        list(hashes),
    ).fetchall()
    conn.close()
    return [
        {"leaf_id": r[0], "output_hash": r[1], "mime": r[2], "witnessed": r[3],
         "leaf_scheme": r[4], "canonicalization_profile": r[5]}
        for r in rows
    ]


def phase_settle(drop_index=None):
    c = client()
    dropped = None
    if drop_index is not None:
        entries = c.queue.load_all()
        if 0 <= drop_index < len(entries):
            dropped = entries.pop(drop_index)
            c.queue.replace_all(entries)

    rec = _reconcile.reconcile(c)
    hashes = [l.content_hash for l in rec.lines if l.content_hash]
    emit({
        "dropped_from_queue": (dropped or {}).get("body", {}).get("content_hash") if dropped else None,
        "drain": {"attempted": rec.drain.attempted, "succeeded": rec.drain.succeeded,
                  "failed": rec.drain.failed, "remaining": rec.drain.remaining},
        "all_clear": rec.all_clear,
        "summary": rec.summary,
        "counts": rec.counts,
        "gaps": [{"seq": g.seq, "filename": g.filename, "content_hash": g.content_hash,
                  "sentence": g.sentence} for g in rec.gaps],
        "lines": [{"seq": l.seq, "disposition": l.disposition, "filename": l.filename,
                   "content_hash": l.content_hash, "leaf_id": l.leaf_id} for l in rec.lines],
        "component_accounting": rec.component,
        "app_rows": _app_rows(hashes),
        "rehash_check": [
            {"filename": l.filename,
             "content_hash": l.content_hash,
             "sha256_on_disk": (sha256_file(os.path.join(BASE, l.filename))
                                if l.filename and os.path.exists(os.path.join(BASE, l.filename)) else None)}
            for l in rec.lines if l.filename
        ],
    })


def phase_witness_down():
    """The app is UP, the witness server is DOWN. /api/v2/witness swallows
    the witness failure by design (route.ts: 'capture must not block on
    witness-server health') and answers 201 with witnessed:false. So the
    capture is DELIVERED and not witnessed -- it is NOT queued and it will
    never be retried."""
    c = client()
    scene, path = render("witnessdown.png", 7)
    outcome = _wf.witness_render(c, scene, trigger="render_complete")
    rec = _state.last_assurance()
    emit({
        "file": os.path.basename(path),
        "sha256_on_disk": sha256_file(path),
        "http_leaf_id": outcome.leaf_id if outcome else None,
        "witnessed": bool(outcome and outcome.witnessed),
        "queued": bool(outcome and outcome.queued),
        "state": rec.state if rec else None,
        "queue_depth": c.queue_depth,
        "app_rows": _app_rows([rec.content_hash] if rec and rec.content_hash else []),
    })


def phase_rebaseline():
    """The addon's code changed for WO-B4, so the tenant's active baseline
    describes different bytes than the ones running. `attach()` reports
    that as drift and keeps going on the server's ref; rebaselining is the
    honest response, and it is what a vendor shipping a new build does."""
    c = client()
    from adapter import baseline_cache as _bc

    result = _wf.rebaseline(
        c,
        reason="capture_point_change",
        detail="WO-B4: capture ledger interposed between hash and submit; offline baseline path",
    )
    emit({
        "baseline_ref": result.baseline_ref,
        "established": result.established,
        "tamper_surface_hash": c.state.tamper_surface_hash,
        "matches": result.baseline_ref == c.state.tamper_surface_hash,
    })


PHASES = {
    "attach": phase_attach,
    "rebaseline": phase_rebaseline,
    "capture": lambda: phase_capture(3, "off"),
    "settle": lambda: phase_settle(None),
    "drop": lambda: phase_capture(3, "drop"),
    "settle_drop": lambda: phase_settle(1),
    "witness_down": phase_witness_down,
}

try:
    PHASES[PHASE]()
except Exception as e:  # a phase that blew up must say so in the file
    import traceback

    emit({"harness_error": str(e), "traceback": traceback.format_exc()})
    sys.exit(3)
