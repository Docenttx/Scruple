"""WO-E4 — the addon as a Level-2 host adapter.

Every test here is about one of three questions, and the third is the one
that is easy to skip:

  1. Does the declaration this addon ships pass the registry the GATE will
     run over it? Not a lookalike -- `scruple_api.host_registry` is the
     Python mirror of `lib/capture/hostRegistry.ts` and it is vendored in
     this zip, so `register_host()` here is the same fifteen refusal codes.

  2. Does an announcement carry facts READ OFF THE SCENE, and does it
     carry every field the addon's own schema says it always contains?

  3. ⚑ Does the addon refuse to announce what it cannot honestly say?
     The SDK's schema check is presence-only, so a document with a null
     camera would be accepted and a leaf would read `supplied` with a null
     in the MAC. `test_the_sdk_would_accept_the_document_this_addon_refuses`
     shows both halves of that in one place: the mirror accepts it, and
     `announce()` writes nothing. That is the difference between a leaf
     that says less and a leaf that says something false.
"""

from __future__ import annotations

import json
import os

import pytest

from adapter import host_hook as _hook
from scruple_api.host_registry import (
    HostRegistration,
    HostRegistrationError,
    _reset_host_registry_for_tests,
    register_host,
)
from scruple_api.surface import Placement, PlacementEnforcement, resolve_placement
from tests.mocks import bpy_mock


@pytest.fixture(autouse=True)
def clean_registry():
    _reset_host_registry_for_tests()
    yield
    _reset_host_registry_for_tests()


@pytest.fixture
def host_dir(tmp_path, monkeypatch):
    d = tmp_path / "hostdir"
    d.mkdir()
    monkeypatch.setenv(_hook.HOST_DIR_ENV, str(d))
    return str(d)


@pytest.fixture
def scene():
    bpy_mock.install()
    bpy_mock.reset()
    import bpy
    yield bpy.context.scene
    bpy_mock.reset()


# ---- 1. the declaration, through the gate's own registry ------------------

def test_the_declaration_registers_through_the_sdks_own_register_host():
    """Step 3 of HOST-HOOK.md's three, and it is not a lookalike check."""
    entry = _hook.register()
    assert entry.registration.host == "blender"
    assert entry.registration.adapter == "comfy-bridge"
    assert entry.registration.evidence_type.endswith("/v1")


def test_registration_is_idempotent_within_a_process():
    """A disable/enable cycle must not raise host_already_registered."""
    first = _hook.register()
    second = _hook.register()
    assert second is first


def test_the_evidence_type_is_a_versioned_predicate_uri():
    """An evidence shape that changes without changing its name is
    unreadable in hindsight, so the registry refuses an unversioned one."""
    bad = HostRegistration(
        **{**_registration_kwargs(), "evidence_type": "scruple.dev/evidence/blender"}
    )
    with pytest.raises(HostRegistrationError) as e:
        register_host(bad)
    assert e.value.code == "evidence_type_unversioned"


def test_the_schema_requires_something():
    """A schema that validates everything makes `declined` unreachable."""
    assert _hook.EVIDENCE_SCHEMA["required"], "required must be non-empty"
    empty = HostRegistration(
        **{**_registration_kwargs(), "schema": {"type": "object", "required": []}}
    )
    with pytest.raises(HostRegistrationError) as e:
        register_host(empty)
    assert e.value.code == "schema_requires_nothing"


def test_the_addon_does_not_grade_itself():
    """⚑ A host declares WHAT IT IS, never HOW GOOD IT IS. The wire form
    must carry no `attestation` key at all -- the gate refuses one."""
    assert "attestation" not in _hook.declaration_document()


def test_declared_placement_is_what_it_can_actually_be_resolved_to():
    """No gap between declared and effective, because the declaration was
    honest to begin with. A zip in a user-writable directory with nothing
    enforcing it IS unattested-client; asking for `attested-client` would
    buy a degradation and a finding, not a grade."""
    r = resolve_placement(_hook.DECLARED_PLACEMENT, _hook.ENFORCEMENT)
    assert r.effective is Placement.UNATTESTED_CLIENT
    assert r.honoured is True


def test_a_dishonest_placement_would_be_degraded():
    """The control for the test above: the degradation is real, so
    `honoured` being True up there is a reading and not a constant."""
    r = resolve_placement(Placement.ATTESTED_CLIENT, PlacementEnforcement.NONE)
    assert r.effective is Placement.UNATTESTED_CLIENT
    assert r.honoured is False


def test_the_wire_form_is_camel_case_and_carries_plain_strings():
    """`scruple-host.json` is read by TypeScript. An enum member that
    serialised as `Placement.UNATTESTED_CLIENT` would be refused with
    `placement_unknown` on the far side."""
    doc = _hook.declaration_document()
    assert doc["declaredPlacement"] == "unattested-client"
    assert doc["hooks"] == ["artifact.produced", "graph.execute"]
    assert doc["fidelity"] == "as-written"
    round_tripped = json.loads(json.dumps(doc))
    assert round_tripped == doc


# ---- 2. the announcement, read off the scene -----------------------------

def test_the_evidence_is_read_off_the_scene(scene):
    scene.name = "atrium"
    scene.frame_current = 12
    scene.camera.name = "CAM_hero"
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 50
    doc = _hook.build_evidence(scene)
    assert doc["scene"] == "atrium"
    assert doc["frame"] == 12
    assert doc["camera"] == "CAM_hero"
    assert doc["engine"] == "CYCLES"
    assert doc["resolution"] == [1280, 720]
    assert doc["resolution_percentage"] == 50
    assert doc["file_format"] == "PNG"
    assert doc["samples"] == 128


def test_every_required_field_is_one_the_scene_actually_produces(scene):
    """The registration promises these are always there. This is the
    promise checked against the code that has to keep it."""
    doc = _hook.build_evidence(scene)
    for key in _hook.EVIDENCE_SCHEMA["required"]:
        assert key in doc and doc[key] is not None, key
    assert _hook.schema_problems(doc) == []


def test_announce_writes_one_document_keyed_by_the_prompt_id(host_dir, scene):
    result = _hook.announce("prompt-abc", scene)
    assert result["ok"] is True
    path = os.path.join(host_dir, _hook.ANNOUNCE_DIR, "prompt-abc.json")
    assert result["wrote"] == path
    with open(path, encoding="utf-8") as f:
        on_disk = json.load(f)
    assert on_disk["scene"] == scene.name
    assert on_disk == result["evidence"]


def test_a_prompt_id_cannot_escape_the_announce_directory(host_dir, scene):
    """The id is chosen by the caller. `announce/../../etc/passwd.json` is
    a path this must not be able to name -- and the read side takes the
    same precaution, which is neither side relying on the other's manners."""
    result = _hook.announce("../../etc/passwd", scene)
    assert result["ok"] is True
    inside = os.path.realpath(os.path.join(host_dir, _hook.ANNOUNCE_DIR))
    assert os.path.realpath(result["wrote"]).startswith(inside)


def test_declare_writes_the_declaration_and_makes_the_announce_dir(host_dir):
    result = _hook.declare()
    assert result["ok"] is True
    assert os.path.isdir(os.path.join(host_dir, _hook.ANNOUNCE_DIR))
    with open(os.path.join(host_dir, _hook.DECLARATION_FILE), encoding="utf-8") as f:
        doc = json.load(f)
    assert doc == _hook.declaration_document()
    # DERIVED by the SDK, not copied from the declaration.
    assert result["effectivePlacement"] == "unattested-client"
    assert result["declaredPlacement"] == result["effectivePlacement"]


# ---- the standalone product, unchanged -----------------------------------

def test_with_no_host_directory_nothing_is_written(tmp_path, monkeypatch, scene):
    """⚑ THE MIRRORED-PRODUCTS RULE, as one assertion. A user with this
    addon and no Desktop Studio enables it and no file appears anywhere."""
    monkeypatch.delenv(_hook.HOST_DIR_ENV, raising=False)
    monkeypatch.chdir(tmp_path)
    assert _hook.declare()["wrote"] is None
    assert _hook.announce("prompt-abc", scene)["wrote"] is None
    assert os.listdir(tmp_path) == []


def test_an_empty_host_directory_variable_is_not_a_directory(monkeypatch, scene):
    monkeypatch.setenv(_hook.HOST_DIR_ENV, "   ")
    assert _hook.host_dir() is None


# ---- 3. ⚑ what the addon refuses to say ----------------------------------

def test_a_scene_with_no_camera_is_not_announced(host_dir, scene):
    """A wire cannot see a camera and neither can a scene that has none.
    Nothing is written, the leaf reads `declined`, and that is TRUE."""
    scene.camera = None
    result = _hook.announce("prompt-nocam", scene)
    assert result["ok"] is False
    assert any("camera" in p for p in result["problems"])
    assert not os.path.exists(
        os.path.join(host_dir, _hook.ANNOUNCE_DIR, "prompt-nocam.json")
    )


def test_the_sdk_would_accept_the_document_this_addon_refuses():
    """⚑ FINDING E4-2, PINNED AS A TEST.

    `hostAdapterSink`'s check is `[k for k in required if k not in
    evidence]` -- presence, not value. A required field present and null
    passes it, and the leaf would read `supplied` with a null camera
    inside the MAC. This addon's own check is presence AND type, so the
    document never leaves Blender.

    If the SDK ever tightens its check, the first assertion goes red and
    this test should be rewritten rather than deleted -- the finding will
    have closed, and that is worth noticing.
    """
    doc = {
        "scene": "atrium", "frame": 1, "camera": None, "engine": "CYCLES",
        "resolution": [1920, 1080], "resolution_percentage": 100,
        "file_format": "PNG",
    }
    sdk_missing = [k for k in _hook.EVIDENCE_SCHEMA["required"] if k not in doc]
    assert sdk_missing == [], "the SDK's presence-only check accepts this document"
    assert _hook.schema_problems(doc) == ["required field 'camera' is null"]


def test_schema_problems_checks_types_not_just_presence():
    base = {
        "scene": "atrium", "frame": 1, "camera": "CAM", "engine": "CYCLES",
        "resolution": [1920, 1080], "resolution_percentage": 100,
        "file_format": "PNG",
    }
    assert _hook.schema_problems(base) == []
    assert _hook.schema_problems({**base, "frame": "12"}) == [
        "'frame' is str, not integer"
    ]
    assert _hook.schema_problems({**base, "frame": True}) == [
        "'frame' is a bool, not an integer"
    ]
    assert _hook.schema_problems({**base, "resolution": [1920]}) == [
        "'resolution' has 1 items, fewer than 2"
    ]
    assert _hook.schema_problems({**base, "resolution": [1920, "1080"]}) == [
        "resolution[1] is str, not integer"
    ]


def test_a_missing_required_field_is_named(host_dir, scene):
    scene.render.image_settings.file_format = ""
    result = _hook.announce("prompt-nofmt", scene)
    assert result["ok"] is False
    assert result["problems"] == ["missing required field 'file_format'"]


def _registration_kwargs():
    r = _hook.registration()
    return {
        "host": r.host,
        "host_version": r.host_version,
        "adapter": r.adapter,
        "adapter_version": r.adapter_version,
        "evidence_type": r.evidence_type,
        "hooks": list(r.hooks),
        "surfaces": list(r.surfaces),
        "fidelity": r.fidelity,
        "declared_placement": r.declared_placement,
        "enforcement": r.enforcement,
        "schema": r.schema,
    }
