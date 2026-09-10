"""WO-G5. The no-AI claim, and every gap that must refuse it.

⚑ THE REFUSALS ARE THE SUBJECT, NOT THE EDGE CASES. `derive()` returning
DIGITAL_CREATION on a clean record is one test; the six ways it must decline are
the reason the module exists. A version of this file that only tested the happy
path would pass against a function that returned DIGITAL_CREATION always.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor"))

from adapter import source_type as st  # noqa: E402
from adapter import host_addons as ha  # noqa: E402


def _entry(name="tex.png", digest="sha256:aa", unreadable=None):
    """Also the real constructor — it is what enforces exactly-one-of."""
    from scruple_host_sdk import imported_datablocks as _im
    return _im.entry(datablock=name, type="image", origin="FILE", packed=True,
                     filename=name, bytes_=10,
                     digest=None if unreadable else digest,
                     digest_of=None if unreadable else _im.DIGEST_OF_PACKED,
                     unreadable=unreadable)


def _imported(entries, source="host_datablocks", origin_observed=False):
    """⚑ BUILT WITH THE REAL CONSTRUCTOR, not by hand.

    The first version of this helper invented its own key names, every test
    passed, and `derive()` refused every document a real Blender produced —
    because `declaration()` writes `source`/`origin_observed` and only
    `wire_fields()` prefixes them. A fixture that does not come from the code
    under test is a test of the fixture.
    """
    from scruple_host_sdk import imported_datablocks as _im
    doc = _im.declaration(entries, datablock_types=["image"], origin_observed=origin_observed)
    if source == "none":
        doc["source"] = "none"
    return doc


def _addons(count=2, unreadable=0, third_party=1):
    return {"addon_set_version": 1, "source": ha.SOURCE_BPY_PREFERENCES,
            "addons": [], "count": count, "unreadable_count": unreadable,
            "third_party_count": third_party}


# ── the claim this plugin exists to make ─────────────────────────────────────

def test_a_complete_record_with_nothing_generative_claims_digital_creation():
    c = st.derive(imported=_imported([_entry()]), addons=_addons())
    assert c.ok
    assert c["digital_source_type"] == st.DIGITAL_CREATION
    # The honest limit rides WITH the claim, not in a footnote.
    assert c["origin_observed"] is False


def test_an_edit_of_existing_work_claims_human_edits():
    c = st.derive(imported=_imported([_entry()]), addons=_addons(), edits_existing_work=True)
    assert c.ok and c["digital_source_type"] == st.HUMAN_EDITS


def test_an_empty_but_ENUMERATED_document_can_still_claim():
    """A Blender with nothing imported is a FACT. It must not read like a
    process that could not look — that distinction is the whole of §1."""
    c = st.derive(imported=_imported([]), addons=_addons())
    assert c.ok and c["digital_source_type"] == st.DIGITAL_CREATION


# ── the six refusals ─────────────────────────────────────────────────────────

def test_no_enumeration_at_all_refuses():
    c = st.derive(imported=None, addons=_addons())
    assert not c.ok and c["code"] == st.NO_DATABLOCK_ENUMERATION
    assert c["digital_source_type"] is None


def test_source_none_refuses_even_with_no_entries():
    c = st.derive(imported=_imported([], source="none"), addons=_addons())
    assert not c.ok and c["code"] == st.NO_DATABLOCK_ENUMERATION


def test_an_unreadable_import_refuses():
    """An import nobody hashed is exactly where a generated asset would be."""
    c = st.derive(imported=_imported([_entry(), _entry("gone.png", unreadable="source_file_missing")]),
                  addons=_addons())
    assert not c.ok and c["code"] == st.UNREADABLE_DATABLOCKS
    assert c["datablocks"] == ["gone.png"]


def test_no_addon_enumeration_refuses():
    c = st.derive(imported=_imported([_entry()]), addons=None)
    assert not c.ok and c["code"] == st.NO_ADDON_ENUMERATION


def test_an_unreadable_addon_refuses():
    c = st.derive(imported=_imported([_entry()]), addons=_addons(unreadable=1))
    assert not c.ok and c["code"] == st.UNREADABLE_ADDONS


def test_a_changed_addon_set_refuses_this_span():
    c = st.derive(imported=_imported([_entry()]), addons=_addons(),
                  addon_change={"comparable": True, "changed": True,
                                "added": ["some_generator"], "removed": [], "altered": []})
    assert not c.ok and c["code"] == st.ADDON_SET_CHANGED
    assert c["added"] == ["some_generator"]


def test_an_UNCHANGED_addon_set_does_not_refuse():
    """The must-NOT-fire beside the must-fire: a comparison that found no change
    has to leave the claim alone, or the refusal above proves nothing."""
    c = st.derive(imported=_imported([_entry()]), addons=_addons(),
                  addon_change={"comparable": True, "changed": False,
                                "added": [], "removed": [], "altered": []})
    assert c.ok and c["digital_source_type"] == st.DIGITAL_CREATION


# ── declared generative material is a fact, not a gap ────────────────────────

def test_known_generative_material_gives_the_composite_type_not_a_refusal():
    c = st.derive(imported=_imported([_entry(), _entry("comfy.png", digest="sha256:bb")]),
                  addons=_addons(), ai_origin_digests=["sha256:bb"])
    assert c.ok
    assert c["digital_source_type"] == st.COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA
    assert c["generative_datablocks"] == ["comfy.png"]


def test_a_digest_that_matches_nothing_leaves_the_claim_alone():
    c = st.derive(imported=_imported([_entry()]), addons=_addons(),
                  ai_origin_digests=["sha256:not-in-this-scene"])
    assert c.ok and c["digital_source_type"] == st.DIGITAL_CREATION


def test_a_plugin_NEVER_asserts_trained_algorithmic_media():
    """🔴 The one value this module must never produce. Studio's answer is the
    exact opposite of the claim a plugin is making."""
    cases = [
        st.derive(imported=_imported([_entry()]), addons=_addons()),
        st.derive(imported=_imported([_entry("c.png", digest="sha256:bb")]), addons=_addons(),
                  ai_origin_digests=["sha256:bb"]),
        st.derive(imported=_imported([_entry()]), addons=_addons(), edits_existing_work=True),
        st.derive(imported=None, addons=None),
    ]
    for c in cases:
        assert c.get("digital_source_type") != st.NEVER_FROM_A_PLUGIN


# ── §4 · the plugin set, and what a change to it looks like ──────────────────

def _m(module, digest="sha256:1", version=(1, 0)):
    return ha.member(module=module, name=module, version=version, path=f"/x/{module}",
                     digest=digest, bytes_=1, files=1, unreadable=None,
                     is_scruple=module.startswith("scruple"))


def test_addon_change_sees_an_installation():
    prev = ha.declaration([_m("scruple_blender")])
    now = ha.declaration([_m("scruple_blender"), _m("some_generator")])
    ch = ha.changed(prev, now)
    assert ch["changed"] and ch["added"] == ["some_generator"] and ch["removed"] == []


def test_addon_change_sees_an_EDIT_IN_PLACE_that_left_the_version_alone():
    """The case a list of names and versions would miss, and the one an attacker
    would use: same module, same version, different bytes."""
    prev = ha.declaration([_m("some_addon", digest="sha256:1")])
    now = ha.declaration([_m("some_addon", digest="sha256:2")])
    ch = ha.changed(prev, now)
    assert ch["changed"] and ch["altered"] == ["some_addon"]


def test_addon_change_is_quiet_when_nothing_moved():
    prev = ha.declaration([_m("scruple_blender"), _m("other")])
    ch = ha.changed(prev, ha.declaration([_m("scruple_blender"), _m("other")]))
    assert ch["comparable"] and not ch["changed"]


def test_an_unenumerated_side_is_not_comparable_rather_than_unchanged():
    ch = ha.changed(None, ha.declaration([_m("scruple_blender")]))
    assert ch["comparable"] is False


def test_a_member_may_not_carry_both_a_digest_and_a_reason_it_has_none():
    import pytest
    with pytest.raises(ValueError):
        ha.member(module="x", name="x", version=(1,), path="/x", digest="sha256:1",
                  bytes_=1, files=1, unreadable="module_unreadable", is_scruple=False)
    with pytest.raises(ValueError):
        ha.member(module="x", name="x", version=(1,), path="/x", digest=None,
                  bytes_=None, files=None, unreadable=None, is_scruple=False)


def test_the_wire_carries_none_and_an_empty_set_differently():
    assert ha.wire_fields(None)["addon_set_source"] == ha.SOURCE_NONE
    empty = ha.wire_fields(ha.declaration([]))
    assert empty["addon_set_source"] == ha.SOURCE_BPY_PREFERENCES and empty["addon_set_count"] == 0
