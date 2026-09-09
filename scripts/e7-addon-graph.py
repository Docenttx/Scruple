#!/usr/bin/env python3
"""Rebuild the graph the STANDALONE ADD-ON put on a leaf, outside Blender, and
print it — so the row-1 question can be asked of a document rather than argued.

    python3 scripts/e7-addon-graph.py --report <e7-addon-alone JSON> [--json]

⚑ IT IS NOT A SECOND IMPLEMENTATION. It imports `/data/scruple-blender`'s own
`adapter/scene.py` builders, its own `adapter/flow.graph_for_wire()` redaction
and its own vendored `scruple_api.canonical.hash_workflow` — the three things
that decide what the add-on sends and what the server hashes. Nothing here
re-derives any of them; the whole point is that the digest it prints must equal
the `workflow_hash` on the leaf, and it can only do that by being the same code.

What it is for: `workflow_hash` is stored and THE GRAPH IS NOT (the v2 witness
route hashes `graph` and discards it). So a verifier holding the leaf cannot
read what the add-on committed to. This reconstructs it from facts the running
Blender reported, and the equality of the hashes is what proves the
reconstruction is the real thing rather than a plausible one.
"""

import argparse
import json
import os
import sys

ADDON = os.environ.get("E7_ADDON_ROOT", "/data/scruple-blender")
sys.path.insert(0, ADDON)
sys.path.insert(0, os.path.join(ADDON, "vendor"))

from adapter import scene as S      # noqa: E402
from adapter import flow as F       # noqa: E402
from scruple_api import canonical as C   # noqa: E402


def graphs_from(report):
    """Every graph this run's captures could have committed to.

    THREE, not two: a still render fires BOTH `render_write` (which carries the
    frame) and `render_complete` (which does not), and the add-on witnesses the
    same file on each. That is measured, not assumed — see finding E7-4.
    """
    out = {}
    render_name = os.path.basename(report["render_path"])
    for trigger, frame in (("render_write", report["frame"]), ("render_complete", None)):
        wf = S.build_render_workflow(
            filename=render_name,
            scene_name=report["scene"],
            render_engine=report["engine"],
            resolution=tuple(report["resolution"]),
            samples=report["samples"],
            camera=report["camera"],
            frame=frame,
            trigger=trigger,
        )
        out[trigger] = F.graph_for_wire(wf)
    out["save_post"] = F.graph_for_wire(S.build_save_workflow(
        filepath=report["blend_path"],
        scene_name=report["scene"],
        object_count=report["object_count"],
        material_count=report["material_count"],
        trigger="save_post",
    ))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    report = json.load(open(a.report))
    graphs = graphs_from(report)
    result = {k: {"graph": g, "workflow_hash": C.hash_workflow(g)} for k, g in graphs.items()}
    if a.json:
        print(json.dumps(result, indent=1, sort_keys=True))
        return
    for k, v in result.items():
        print(f"   {k}")
        print(f"      workflow_hash  {v['workflow_hash']}")
        print(f"      graph          {json.dumps(v['graph'], sort_keys=True)}")
        # The whole key set, spelled out, because the claim is about what is
        # NOT in it.
        print(f"      keys           {sorted(v['graph'])}")


main()
