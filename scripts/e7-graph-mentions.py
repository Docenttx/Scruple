#!/usr/bin/env python3
"""How many times the add-on's own render graph mentions the image that was
imported into the scene it rendered.

    python3 scripts/e7-graph-mentions.py <graphs.json> <report.json>

The answer WO-E7 measures is 0, and the needles are deliberately generous —
the datablock's own name, its path on disk, and four words any field about an
imported picture would have to contain. A count of 0 over that set is the
strongest available form of "the add-on's leaf says nothing about what was
imported"; it is not a proof that no future field could, which is why the
report states it as a measurement of this graph and not as a theorem.
"""
import json
import sys

graph = json.load(open(sys.argv[1]))["render_write"]["graph"]
rep = json.load(open(sys.argv[2]))
needles = [
    rep["imported_image"]["datablock"],
    rep["imported_image"]["source_path"],
    "imported", "image", "texture", "ai",
]
blob = json.dumps(graph).lower()
print(sum(1 for n in needles if n and str(n).lower() in blob))
