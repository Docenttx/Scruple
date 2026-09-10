"""WO-F3 — the add-on declares what entered the document from outside it.

Closing WO-E7 finding **E7-1**, the finding the E series ends on: two Blender
scenes built around two DIFFERENT AI images produced leaves identical in every
column capable of saying how the artifact came to exist. Nothing on them was
false. The claim was ABSENT, and absence and "there was nothing" read the same.

WHAT IS TESTED HERE AND WHAT IS NOT. These tests run against the bpy MOCK, so
what they can prove is the enumerator's rules and that the declaration reaches
the wire. What they cannot prove is that real Blender's `packed_file.data` is
the source file's bytes — that is a measurement, it is
`scripts/f3-datablock-probe.py` in the desktop repo, and the mock's docstring
records the result rather than assuming it.

EVERY GATE HAS A CONTROL BESIDE IT:

  THE GATE     two scenes around two different images produce two different
               declarations, each naming the datablock and its digest.
  CONTROL (a)  a scene with NO imported datablocks declares an EMPTY set that
               is PRESENT — count 0 with the scope it ranged over — never an
               absent field.
  CONTROL (b)  a datablock whose bytes cannot be read is a MEMBER with a
               reason, not an omission and not somebody else's digest.
  ANTI-VACUITY `Render Result` and `Viewer Node` are in `bpy.data.images` on
               every real startup and must NOT be declared as imports. A
               filter that counted datablocks would make control (a) pass by
               accident and the gate pass for the wrong reason.
"""

from __future__ import annotations

import hashlib

import pytest

from adapter import flow as _wf
from adapter import scene as _scene
from scruple_host_sdk import imported_datablocks as _imported
from tests.mocks import bpy_mock, v2

AI_A = b"\x89PNG\r\n\x1a\n" + b"the first generated image"
AI_B = b"\x89PNG\r\n\x1a\n" + b"a different generated image"


def _packed(name, data, filepath="/tmp/nowhere/generated.png"):
    return bpy_mock.Image(
        name=name, source="FILE", filepath=filepath,
        packed_file=bpy_mock.PackedFile(data=data),
    )


def _render_scene(tmp_path, name="img.png", data=b"pixels"):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / name)
    (tmp_path / name).write_bytes(data)
    return scene


def _declaration_posted(http_opener):
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][-1].body
    return posted


# ---- the enumerator -----------------------------------------------------

def test_a_packed_image_is_declared_with_the_digest_of_its_bytes(bpy_installed):
    bpy_installed.data.images.append(_packed("imported-from-somewhere-else", AI_A))
    doc = _scene.imported_datablocks()
    assert doc["source"] == "host_datablocks"
    assert doc["origin_observed"] is False
    assert doc["datablock_types"] == ["image"]
    [m] = doc["datablocks"]
    assert m["datablock"] == "imported-from-somewhere-else"
    assert m["digest"] == hashlib.sha256(AI_A).hexdigest()
    assert m["digest_of"] == _imported.DIGEST_OF_PACKED
    assert m["packed"] is True
    assert m["bytes"] == len(AI_A)
    assert m["unreadable"] is None
    # ⚑ BASENAME ONLY. A leaf is not the place for a user's directory layout.
    assert m["filename"] == "generated.png"


def test_THE_GATE_two_different_images_two_different_declarations(bpy_installed):
    bpy_installed.data.images.append(_packed("import", AI_A))
    a = _imported.wire_fields(_scene.imported_datablocks())
    bpy_installed.data.images.pop()
    bpy_installed.data.images.append(_packed("import", AI_B))
    b = _imported.wire_fields(_scene.imported_datablocks())
    # The digest of the document moves, which is what the leaf carries — and
    # under the SAME count, the same scope and the same datablock NAME. Nothing
    # but the bytes is different, which is exactly WO-E7's experiment.
    assert a["imported_datablocks_count"] == b["imported_datablocks_count"] == 1
    assert a["imported_datablocks_hash"] != b["imported_datablocks_hash"]


def test_an_unpacked_image_is_hashed_from_the_file_on_disk(bpy_installed, tmp_path):
    p = tmp_path / "on-disk.png"
    p.write_bytes(AI_A)
    bpy_installed.data.images.append(
        bpy_mock.Image(name="linked", source="FILE", filepath=str(p))
    )
    [m] = _scene.imported_datablocks()["datablocks"]
    assert m["digest"] == hashlib.sha256(AI_A).hexdigest()
    assert m["digest_of"] == _imported.DIGEST_OF_SOURCE_FILE
    assert m["packed"] is False


def test_CONTROL_b_a_datablock_whose_bytes_are_gone_is_a_member_with_a_reason(bpy_installed, tmp_path):
    """⚑ Not omitted. An import nobody could hash must not read as no import."""
    bpy_installed.data.images.append(
        bpy_mock.Image(name="vanished", source="FILE", filepath=str(tmp_path / "deleted.png"))
    )
    doc = _scene.imported_datablocks()
    [m] = doc["datablocks"]
    assert m["datablock"] == "vanished"
    assert m["digest"] is None
    assert m["unreadable"] == _imported.UNREADABLE_MISSING
    w = _imported.wire_fields(doc)
    assert w["imported_datablocks_count"] == 1
    assert w["imported_datablocks_unreadable_count"] == 1


def test_a_datablock_with_no_filepath_at_all_says_so(bpy_installed):
    bpy_installed.data.images.append(bpy_mock.Image(name="pathless", source="FILE", filepath=""))
    [m] = _scene.imported_datablocks()["datablocks"]
    assert m["unreadable"] == _imported.UNREADABLE_NO_SOURCE
    assert m["filename"] is None


def test_a_datablock_over_the_digest_bound_keeps_its_byte_count(bpy_installed, tmp_path):
    """WO-D3's rule: the refusal keeps the member, and the byte COUNT survives
    it. A user waiting on a save must not wait on a 2 GB texture, and the
    honest record of that is a member with a reason, not a shorter list."""
    p = tmp_path / "huge.exr"
    p.write_bytes(AI_A)
    got = _imported.digest_file(str(p), limit=4)
    assert got["digest"] is None
    assert got["unreadable"] == _imported.UNREADABLE_OVER_LIMIT
    assert got["bytes"] == len(AI_A)


# ---- control (a) and the anti-vacuity control ---------------------------

def test_CONTROL_a_no_imports_is_an_EMPTY_declaration_THAT_IS_PRESENT(bpy_installed):
    doc = _scene.imported_datablocks()
    assert doc is not None
    assert doc["datablocks"] == []
    w = _imported.wire_fields(doc)
    # 0 is a count. None would be "nothing enumerated", which is a different
    # fact and is spelled `source: "none"`.
    assert w["imported_datablocks_count"] == 0
    assert w["imported_datablocks_unreadable_count"] == 0
    assert w["imported_datablocks_hash"]
    assert w["imported_origin_observed"] is False


def test_ANTI_VACUITY_the_render_result_and_the_viewer_are_not_imports(bpy_installed):
    """Both are in `bpy.data.images` on every real Blender startup. A filter
    that counted datablocks rather than reading `source` would declare them —
    and would make the empty-scene control pass for the wrong reason."""
    assert [i.name for i in bpy_installed.data.images] == ["Render Result", "Viewer Node"]
    assert _scene.imported_datablocks()["datablocks"] == []


def test_a_GENERATED_image_is_not_an_import_either(bpy_installed):
    bpy_installed.data.images.append(bpy_mock.Image(name="made-here", source="GENERATED"))
    assert _scene.imported_datablocks()["datablocks"] == []


def test_the_scope_it_ranged_over_travels_in_the_document(bpy_installed):
    """WO-E2's rule applied to a document: without the scope, "no imports"
    cannot be told from "no imports of the one kind anybody looked at"."""
    assert _scene.imported_datablocks()["datablock_types"] == list(
        _scene.IMPORTED_DATABLOCK_TYPES
    )


def test_the_addon_never_claims_it_watched_the_import(bpy_installed):
    """The one claim the field exists to make. The server refuses `True` from
    anybody today, and the add-on does not ask."""
    assert _scene.imported_datablocks()["origin_observed"] is False


# ---- the wire -----------------------------------------------------------

def test_the_declaration_reaches_the_submission(attached_client, http_opener, tmp_path, bpy_installed):
    bpy_installed.data.images.append(_packed("import", AI_A))
    scene = _render_scene(tmp_path)
    _wf.witness_render(attached_client, scene, trigger="render_complete")
    posted = _declaration_posted(http_opener)
    assert posted["imported_datablocks_source"] == "host_datablocks"
    assert posted["imported_origin_observed"] is False
    assert posted["imported_datablocks_count"] == 1
    assert posted["imported_datablocks_unreadable_count"] == 0
    assert posted["imported_datablocks_hash"] == _imported.document_hash(
        posted["imported_datablocks"]
    )
    assert posted["imported_datablocks"]["datablocks"][0]["digest"] == hashlib.sha256(
        AI_A
    ).hexdigest()


def test_the_five_scalars_are_TOP_LEVEL_and_not_in_capture(attached_client, http_opener, tmp_path, bpy_installed):
    """⚑ The placement is the design decision, and it is asserted rather than
    assumed. `capture` is what a capture COMPONENT observed, and the server
    obliges any capture-bearing leaf to declare an attestation basis, a
    profile, a confinement, an upstream epoch and a host level. The add-on is a
    plugin with none of those; a declaration inside `capture` would oblige it
    to invent all five to say one true thing, and the route refuses it there."""
    bpy_installed.data.images.append(_packed("import", AI_A))
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    posted = _declaration_posted(http_opener)
    assert "capture" not in posted
    for k in (
        "imported_datablocks_source", "imported_origin_observed",
        "imported_datablocks_count", "imported_datablocks_unreadable_count",
        "imported_datablocks_hash",
    ):
        assert k in posted


def test_a_save_carries_the_declaration_too(attached_client, http_opener, tmp_path, bpy_installed):
    """The .blend is where the packed image actually IS, so this is the leaf
    the digest is most obviously about."""
    bpy_installed.data.images.append(_packed("import", AI_A))
    blend = tmp_path / "doc.blend"
    blend.write_bytes(b"BLENDER-v420")
    bpy_installed.data.filepath = str(blend)
    _wf.witness_save(attached_client, bpy_mock.Scene(), str(blend), trigger="save_post")
    posted = _declaration_posted(http_opener)
    assert posted["imported_datablocks_count"] == 1


def test_a_spooled_capture_keeps_its_declaration(attached_client, http_opener, tmp_path, bpy_installed):
    """The queue replays the SUBMISSION, so a capture taken during an outage
    must not come back thinner than it went in."""
    bpy_installed.data.images.append(_packed("import", AI_A))
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    outcome = _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert outcome.queued is True
    [entry] = attached_client.queue.load_all()
    body = entry["body"] if isinstance(entry, dict) else entry.body
    assert body["imported_datablocks_count"] == 1
    assert body["imported_datablocks_hash"]
