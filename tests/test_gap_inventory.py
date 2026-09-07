"""WO-B1's gate, as a test that can fail.

The gate is: gap.json parses, every row cites file:line, and the baseline
suite count is recorded. `test_gap_json_verifies` is the must-fire check.

Everything after it is the control. A green check with no control proves
only that it cannot fail, so each of the four ways a citation can rot --
a bad line number, a bad quote, a bad file, a row with no citation at
all -- is injected into a copy of the real gap.json and asserted to make
the verifier fail. If someone "fixes" verify_gap.py by making it always
return [], these four go red.
"""

from __future__ import annotations

import copy
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import verify_gap  # noqa: E402

GAP_PATH = os.path.join(ROOT, "docs", "canon", "blender-l2", "gap.json")


@pytest.fixture
def gap():
    with open(GAP_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(tmp_path, doc):
    p = tmp_path / "gap.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return str(p)


# ---- must fire -------------------------------------------------------

def test_gap_json_verifies():
    """The real gap.json: parses, three tables, every citation resolves to
    a line that actually contains its quote."""
    assert verify_gap.verify(GAP_PATH) == []


def test_gap_json_has_all_three_tables_and_they_are_populated(gap):
    for table, _ in verify_gap.TABLES:
        assert isinstance(gap[table], list), f"{table} is not a list"
        assert gap[table], f"{table} is empty"


def test_every_row_in_every_table_cites_something(gap):
    for table, name_key in verify_gap.TABLES:
        for row in gap[table]:
            cites = verify_gap.collect_citations(row)
            assert cites, f"{table} row {row.get(name_key)!r} cites nothing"


def test_baseline_count_is_recorded_and_is_what_was_observed(gap):
    b = gap["baseline_suite"]
    # 81 is what WO-B1 expected AND what was observed at aa889a2. If a
    # later commit changes the count, this is the line that says so.
    assert b["passed"] == 81
    assert b["failed"] == 0
    assert b["expected"] == 81
    assert b["matches_expected"] is True


def test_the_addon_calls_no_v2_route(gap):
    """The premise of the whole WO series, asserted rather than assumed."""
    assert gap["summary"]["v2_routes_the_addon_calls"] == 0
    assert len(gap["v2_surface_unused"]) == gap["summary"]["v2_routes_on_server"]


# ---- must NOT fire: break it four ways, each must be caught ----------

def test_control_a_wrong_line_number_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    doc["endpoints"][0]["cite"]["line"] += 1
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert errors, "sliding a citation by one line was not caught"
    assert any("quote not on" in e for e in errors)


def test_control_a_wrong_quote_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    doc["modules"][0]["cite"]["quote"] = "this text is not in that file"
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert errors, "a quote that is not on the cited line was not caught"
    assert any("quote not on" in e for e in errors)


def test_control_a_missing_file_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    doc["floor_items"][0]["cite"]["file"] = "lib/does_not_exist.py"
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert any("no such file" in e for e in errors)


def test_control_a_row_that_cites_nothing_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    doc["endpoints"].append({"addon_call": "GET /invented", "status": "no_equivalent"})
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert any("cites nothing" in e for e in errors)


def test_control_a_missing_table_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    del doc["floor_items"]
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert any("floor_items" in e and "missing or empty" in e for e in errors)


def test_control_a_missing_baseline_count_is_caught(tmp_path, gap):
    doc = copy.deepcopy(gap)
    del doc["baseline_suite"]["passed"]
    errors = verify_gap.verify(_write(tmp_path, doc))
    assert any("baseline_suite.passed" in e for e in errors)


# ---- the markdown and the json cannot disagree ------------------------

def test_gap_md_tables_are_generated_from_gap_json():
    """01-GAP.md's three tables are rendered from gap.json. If someone
    edits a row in the prose and not in the JSON, this fails."""
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import render_gap_md

    with open(render_gap_md.GAP, "r", encoding="utf-8") as f:
        gap = json.load(f)
    with open(render_gap_md.MD, "r", encoding="utf-8") as f:
        source = f.read()
    assert render_gap_md.rendered_markdown(source, gap) == source, (
        "01-GAP.md is stale — re-run tools/render_gap_md.py"
    )


def test_control_editing_gap_json_makes_the_md_stale(gap):
    """The control for the check above: change the JSON without
    re-rendering and the comparison must notice."""
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import render_gap_md

    doc = copy.deepcopy(gap)
    doc["floor_items"][0]["status"] = "met"          # a lie, deliberately
    with open(render_gap_md.MD, "r", encoding="utf-8") as f:
        source = f.read()
    assert render_gap_md.rendered_markdown(source, doc) != source
