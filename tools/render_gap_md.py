#!/usr/bin/env python3
"""Render the three WO-B1 tables from gap.json into 01-GAP.md.

The prose in 01-GAP.md is hand-written. The tables are not: they are
generated between the BEGIN/END markers so the human-readable and the
machine-readable inventory cannot disagree. tests/test_gap_inventory.py
re-runs this into a temp file and fails if what is on disk differs, which
is what makes "cannot disagree" a check rather than an intention.

Usage:  python3 tools/render_gap_md.py [--check]
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAP = os.path.join(ROOT, "docs", "canon", "blender-l2", "gap.json")
MD = os.path.join(ROOT, "docs", "canon", "blender-l2", "01-GAP.md")


def esc(s: object) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


def cite_str(c: dict | None) -> str:
    if not c:
        return "—"
    prefix = "" if c["repo"] == "addon" else "web:"
    return f"`{prefix}{c['file']}:{c['line']}`"


def render_endpoints(g: dict) -> str:
    out = ["| # | Addon calls | cited at | v2 replacement | status | what changes |",
           "|---|---|---|---|---|---|"]
    for i, r in enumerate(g["endpoints"], 1):
        out.append(
            f"| {i} | `{esc(r['addon_call'])}` | {cite_str(r.get('cite'))} | "
            f"{('`' + esc(r['v2_replacement']) + '`') if r.get('v2_replacement') else '**no equivalent**'} | "
            f"`{r['status']}` | {esc(r['behaviour_delta'])} |"
        )
    return "\n".join(out)


def render_modules(g: dict) -> str:
    out = ["| # | `scruple_blender/lib/` | LOC | superseded by | differs? | verdict | why |",
           "|---|---|---|---|---|---|---|"]
    for i, r in enumerate(g["modules"], 1):
        out.append(
            f"| {i} | `{esc(r['addon_module'])}` {cite_str(r.get('cite'))} | {r['lines']} | "
            f"{esc(r['sdk_module'])} {cite_str(r.get('sdk_cite'))} | "
            f"{'**yes**' if r['differs'] else 'no'} | `{esc(r['verdict'])}` | {esc(r['difference'])} |"
        )
    return "\n".join(out)


def render_floor(g: dict) -> str:
    out = ["| # | Floor item | cited at | status | what the addon does about it today | closes in |",
           "|---|---|---|---|---|---|"]
    for i, r in enumerate(g["floor_items"], 1):
        out.append(
            f"| {i} | {esc(r['item'])} | {cite_str(r.get('cite'))} | **`{r['status']}`** | "
            f"{esc(r['addon_today'])} | {esc(r.get('closes_in', '—'))} |"
        )
    return "\n".join(out)


RENDERERS = {
    "endpoints": render_endpoints,
    "modules": render_modules,
    "floor_items": render_floor,
}


def rendered_markdown(source: str, gap: dict) -> str:
    out = source
    for name, fn in RENDERERS.items():
        begin = f"<!-- BEGIN GENERATED: {name} -->"
        end = f"<!-- END GENERATED: {name} -->"
        if begin not in out or end not in out:
            raise SystemExit(f"01-GAP.md has no {begin} / {end} markers")
        head = out[: out.index(begin) + len(begin)]
        tail = out[out.index(end):]
        out = head + "\n\n" + fn(gap) + "\n\n" + tail
    return out


def main() -> int:
    with open(GAP, "r", encoding="utf-8") as f:
        gap = json.load(f)
    with open(MD, "r", encoding="utf-8") as f:
        source = f.read()
    result = rendered_markdown(source, gap)
    if "--check" in sys.argv:
        if result != source:
            print("01-GAP.md is stale — re-run tools/render_gap_md.py", file=sys.stderr)
            return 1
        print("01-GAP.md tables match gap.json")
        return 0
    with open(MD, "w", encoding="utf-8") as f:
        f.write(result)
    print(f"rendered {len(RENDERERS)} tables into {MD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
