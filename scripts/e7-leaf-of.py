#!/usr/bin/env python3
"""The leaf id the ADD-ON ITSELF was handed for one capture.

    python3 scripts/e7-leaf-of.py <report.json> <graphs.json> <trigger>

Matched on the workflow hash the add-on computed CLIENT-SIDE, before anything
was sent (`LeafAssurance.canonicalization.client_workflow_hash`), against the
graph rebuilt outside Blender for that trigger. Not "the newest row": WO-E7
runs the add-on twice with the same scene on purpose, so two of its leaves
carry the same `workflow_hash` and only the receipt tells them apart.
"""
import json
import sys

rep = json.load(open(sys.argv[1]))
want = json.load(open(sys.argv[2]))[sys.argv[3]]["workflow_hash"]
for a in rep["assurances"]:
    if a["canonicalization"]["client_workflow_hash"] == want and a.get("leaf_id"):
        print(a["leaf_id"])
        break
