#!/usr/bin/env python3
"""Verify docs/canon/blender-l2/gap.json against the trees it describes.

WO-B1's gate is "gap.json parses; every row cites file:line". A row that
cites a line number nobody checked is a footnote, not a citation -- the
line numbers in a hand-written inventory rot the first time anyone edits
the file above them. So every citation in gap.json carries a `quote`, and
this script opens the cited file, reads the cited line, and fails if the
quote is not on it.

That gives the check a must-NOT-fire control for free: corrupt any quote,
or slide any line number by one, and this fails. tests/test_gap_inventory.py
exercises exactly that.

Two roots, because the gap spans two repos:
  repo="addon"  -> this repository
  repo="server" -> /data/scruple-web (override with SCRUPLE_WEB_ROOT)

Usage:  python3 tools/verify_gap.py [path/to/gap.json]
Exit 0 clean, 1 with a numbered list of what failed.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Tuple

ADDON_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_ROOT = os.environ.get("SCRUPLE_WEB_ROOT", "/data/scruple-web")

DEFAULT_GAP = os.path.join(ADDON_ROOT, "docs", "canon", "blender-l2", "gap.json")

# The three tables WO-B1 requires, and the key each row is named by in an
# error message.
TABLES: Tuple[Tuple[str, str], ...] = (
    ("endpoints", "addon_call"),
    ("modules", "addon_module"),
    ("floor_items", "item"),
)


def _root_for(repo: str) -> str:
    if repo == "addon":
        return ADDON_ROOT
    if repo == "server":
        return SERVER_ROOT
    raise KeyError(repo)


_line_cache: Dict[str, List[str]] = {}


def _lines(path: str) -> List[str]:
    if path not in _line_cache:
        with open(path, "r", encoding="utf-8") as f:
            _line_cache[path] = f.read().splitlines()
    return _line_cache[path]


def check_citation(cite: Any, where: str, errors: List[str]) -> None:
    """A citation is {repo, file, line, quote} and all four must hold."""
    if not isinstance(cite, dict):
        errors.append(f"{where}: citation is not an object: {cite!r}")
        return
    for field in ("repo", "file", "line", "quote"):
        if field not in cite:
            errors.append(f"{where}: citation missing `{field}`")
            return
    try:
        root = _root_for(cite["repo"])
    except KeyError:
        errors.append(f"{where}: unknown repo {cite['repo']!r} (want addon|server)")
        return

    path = os.path.join(root, cite["file"])
    if not os.path.isfile(path):
        errors.append(f"{where}: no such file {cite['repo']}:{cite['file']}")
        return

    lines = _lines(path)
    n = cite["line"]
    if not isinstance(n, int) or n < 1 or n > len(lines):
        errors.append(
            f"{where}: line {n} out of range for {cite['file']} ({len(lines)} lines)"
        )
        return

    quote = cite["quote"]
    if quote not in lines[n - 1]:
        errors.append(
            f"{where}: quote not on {cite['file']}:{n}\n"
            f"      wanted: {quote!r}\n"
            f"      line is: {lines[n - 1].strip()!r}"
        )


def collect_citations(row: Dict[str, Any]) -> List[Tuple[str, Any]]:
    """Every key ending in `cite` or `cites`, flattened. A row may cite the
    addon, the server, both, or several of each."""
    found: List[Tuple[str, Any]] = []
    for key, value in row.items():
        if not (key == "cite" or key.endswith("_cite") or key.endswith("_cites")):
            continue
        if value is None:
            continue
        if isinstance(value, list):
            for i, v in enumerate(value):
                found.append((f"{key}[{i}]", v))
        else:
            found.append((key, value))
    return found


def verify(gap_path: str) -> List[str]:
    errors: List[str] = []

    try:
        with open(gap_path, "r", encoding="utf-8") as f:
            gap = json.load(f)
    except FileNotFoundError:
        return [f"gap.json not found at {gap_path}"]
    except json.JSONDecodeError as e:
        return [f"gap.json does not parse: {e}"]

    for table, name_key in TABLES:
        rows = gap.get(table)
        if not isinstance(rows, list) or not rows:
            errors.append(f"table `{table}` is missing or empty")
            continue
        for i, row in enumerate(rows):
            label = row.get(name_key, f"#{i}") if isinstance(row, dict) else f"#{i}"
            where = f"{table}[{i}] {label}"
            if not isinstance(row, dict):
                errors.append(f"{where}: row is not an object")
                continue
            cites = collect_citations(row)
            if not cites:
                errors.append(f"{where}: row cites nothing -- every row must cite file:line")
                continue
            for key, cite in cites:
                check_citation(cite, f"{where}.{key}", errors)

    baseline = gap.get("baseline_suite")
    if not isinstance(baseline, dict) or "passed" not in baseline:
        errors.append("baseline_suite.passed is missing -- the gate requires the observed count")

    return errors


def main() -> int:
    gap_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GAP
    errors = verify(gap_path)
    if errors:
        print(f"FAIL  {len(errors)} problem(s) in {gap_path}\n", file=sys.stderr)
        for i, e in enumerate(errors, 1):
            print(f"  {i:>3}. {e}", file=sys.stderr)
        return 1

    with open(gap_path, "r", encoding="utf-8") as f:
        gap = json.load(f)
    total = sum(len(gap[t]) for t, _ in TABLES)
    cites = sum(len(collect_citations(r)) for t, _ in TABLES for r in gap[t])
    print(f"OK  {gap_path}")
    for t, _ in TABLES:
        print(f"    {t:<12} {len(gap[t]):>3} rows")
    print(f"    {'TOTAL':<12} {total:>3} rows, {cites} citations, all resolved to a line that contains their quote")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
