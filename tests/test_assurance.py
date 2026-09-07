"""WO-B3 -- the v2 witness path, at L2.

Every test here has a control, and the controls are the point. A test
asserting "the addon records the assurance tier" passes just as well
against an addon that records `verified` on everything, so each
must-fire assertion below is paired with a must-NOT-fire one:

  the tier is honest              <-> it is NOT 'verified' when nothing verified it
  the kind is a v2 enum member    <-> an unmapped kind is refused BEFORE any request
  a signature is read when sent   <-> absence is 'not_disclosed', never 'unsigned'
  verify's claim is recorded      <-> it is NEVER promoted to 'checked'
  the graph reaches the server    <-> an absolute path does NOT
  a queued capture is queued      <-> a rejected one is NOT called queued
"""

from __future__ import annotations

import hashlib

import pytest

from adapter import assurance as _a
from adapter import flow as _wf
from adapter import state as _state
from scruple_api import canonical as _canonical
from tests.mocks import bpy_mock, v2


def _render_scene(tmp_path, name="img.png", data=b"pixels"):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / name)
    (tmp_path / name).write_bytes(data)
    return scene


def _posted(http_opener):
    return [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body


# ---- the closed `kind` enum -------------------------------------------
# The defect that meant no leaf this addon produced had ever landed.

def test_a_render_is_witnessed_as_the_v2_kind_artifact(attached_client, http_opener, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert _posted(http_opener)["kind"] == "artifact"


def test_a_save_is_witnessed_as_the_v2_kind_document_save(attached_client, http_opener, tmp_path):
    p = tmp_path / "s.blend"
    p.write_bytes(b"BLENDER-fake")
    _wf.witness_save(attached_client, bpy_mock.Scene(), str(p))
    assert _posted(http_opener)["kind"] == "document_save"


def test_every_mapped_kind_is_a_member_of_the_closed_enum():
    for capture_kind in _wf.CAPTURE_KIND:
        assert _wf.leaf_kind_for(capture_kind) in _wf.LEAF_KINDS


def test_blenders_own_word_survives_in_the_graph(attached_client, http_opener, tmp_path):
    """The leaf kind is the server's vocabulary; Blender's is not lost --
    it is in the graph, which enters workflow_hash."""
    _wf.witness_render(attached_client, _render_scene(tmp_path), trigger="render_complete")
    graph = _posted(http_opener)["graph"]
    assert graph["kind"] == "blender_render"
    assert graph["trigger"] == "render_complete"


# CONTROL: an unmapped capture kind must be refused HERE, not by a 400.
def test_an_unmapped_capture_kind_is_refused_before_any_request(attached_client, http_opener):
    before = len(http_opener.recorded)
    with pytest.raises(_wf.UnknownCaptureKind):
        _wf.leaf_kind_for("checkpoint")
    assert len(http_opener.recorded) == before, "a refusal must not send a request"


def test_a_rejected_kind_is_recorded_as_rejected_and_not_as_queued(attached_client, http_opener, tmp_path):
    """A 400 is delivered, refused and NOT queued (http.py:162 queues
    transport failures and 5xx only). Calling it 'queued' would tell the
    user their capture is coming back."""
    http_opener.register("POST", "/api/v2/witness", {"error": {"code": "invalid_body"}}, status=400)
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    assert rec.state == _a.REJECTED
    assert rec.state != _a.QUEUED
    assert attached_client.queue_depth == 0, "a 4xx must not be spooled"


# ---- the measurement-honesty states ------------------------------------

def test_the_three_states_the_route_names_are_all_representable():
    for state in _a.MEASUREMENT_HONESTY_STATES:
        assert state in _a.STATES
        assert _a.sentence_for(state) != f"Unknown state {state!r}."


def test_a_witnessed_capture_is_recorded_as_witnessed(attached_client, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert _state.last_assurance().state == _a.WITNESSED


def test_a_delivered_but_unwitnessed_capture_is_not_called_witnessed(sdk_client, http_opener, tmp_path):
    v2.register_v2(http_opener, witnessed=False)
    sdk_client.attach(code_paths=[])
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    assert rec.state == _a.DELIVERED_NOT_WITNESSED
    assert rec.witnessed is False
    assert rec.leaf_id, "the server did answer -- it just did not witness"


def test_an_undeliverable_capture_is_queued_not_lost(sdk_client, http_opener, tmp_path):
    v2.register_v2(http_opener)
    sdk_client.attach(code_paths=[])
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    assert rec.state == _a.QUEUED
    assert rec.queue_depth_after == 1


def test_a_local_refusal_is_visible_and_not_a_silence(attached_client, tmp_path):
    """Vendor floor item 5: a capture that never happened must not look
    like an afternoon in which nothing was rendered."""
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "x.png")
    (tmp_path / "x.png").write_bytes(b"px")
    scene.render.image_settings.file_format = "SOMETHING_UNDECLARABLE"
    _wf.witness_render(attached_client, scene)
    rec = _state.last_assurance()
    assert rec.state == _a.REFUSED_LOCALLY
    assert rec.error


def test_the_tracker_counts_each_state_separately(attached_client, http_opener, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path, "a.png", b"a"))
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    _wf.witness_render(attached_client, _render_scene(tmp_path, "b.png", b"b"))
    counts = _state.state_counts()
    assert counts[_a.WITNESSED] == 1
    assert counts[_a.QUEUED] == 1


# ---- the H-1 signature triple ------------------------------------------

def test_absence_of_a_signature_is_recorded_as_not_disclosed(attached_client, tmp_path):
    """THE CORE HONESTY PROPERTY. Today's server returns no signature
    field, and 'the server told us there is none' is a different fact
    from 'nobody was asked'. Recording the first would be a claim the
    addon has no basis for."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(attached_client, _state.last_assurance())
    assert rec.signature.leaf_signature is None
    assert rec.signature.source == _a.NOT_DISCLOSED
    assert "cannot tell a signed leaf from an unsigned one" in rec.signature.explanation


def test_a_disclosed_signature_is_read_out_by_name(sdk_client, http_opener, tmp_path):
    """The read path against a server that DOES carry the triple. No such
    server exists today -- this proves the code is written, not that the
    field arrives."""
    v2.register_v2_disclosing(http_opener)
    sdk_client.attach(code_paths=[])
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(sdk_client, _state.last_assurance())
    assert rec.signature.leaf_signature == v2.SURROGATE_SIGNATURE["leaf_signature"]
    assert rec.signature.leaf_signer_key_id == v2.SURROGATE_SIGNATURE["leaf_signer_key_id"]
    assert rec.signature.leaf_signature_alg == "ECDSA_SHA_256"
    assert rec.signature.source == _a.FROM_RECEIPT


# CONTROL: a surrogate-signed leaf must never read as hardware-backed.
def test_a_surrogate_signed_leaf_is_never_recorded_as_verified(sdk_client, http_opener, tmp_path):
    v2.register_v2_disclosing(http_opener)
    sdk_client.attach(code_paths=[])
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(sdk_client, _state.last_assurance())
    assert rec.signature.signer_surrogate is True
    assert rec.assurance_tier == "passthrough (software-signed)"
    assert rec.assurance_tier != "verified"
    assert "NOT hardware-backed" in rec.signature.explanation


def test_the_tier_is_never_verified_without_both_an_attestation_and_a_signature():
    """Exhaustive over the two inputs, so no combination can quietly
    produce 'verified' except the one that earns it."""
    sig_present = _a.SignatureRecord(
        leaf_signature="MEYC", leaf_signature_alg="ECDSA_SHA_256",
        signer_surrogate=False, source=_a.FROM_RECEIPT,
    )
    cases = {
        (None, False): "undisclosed",
        ("passthrough", False): "undisclosed",
        ("verified", False): "undisclosed",
        (None, True): "passthrough",
        ("passthrough", True): "passthrough",
        ("verified", True): "verified",
    }
    for (att, has_sig), expected in cases.items():
        rec = _a.LeafAssurance(
            state=_a.WITNESSED, kind="render", mime="image/png",
            attestation_status=att,
            signature=sig_present if has_sig else _a.SignatureRecord(),
        )
        assert rec.assurance_tier == expected, (att, has_sig)


def test_a_capture_that_was_not_witnessed_has_no_tier_at_all():
    for state in (_a.QUEUED, _a.REJECTED, _a.REFUSED_LOCALLY, _a.DELIVERED_NOT_WITNESSED):
        rec = _a.LeafAssurance(state=state, kind="render", mime="image/png")
        assert rec.assurance_tier == "not witnessed"


# ---- receipt and verify -------------------------------------------------

def test_the_receipt_is_fetched_from_the_v2_route(attached_client, http_opener, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    _wf.resolve_assurance(attached_client, rec)
    paths = [r.path for r in http_opener.recorded]
    assert f"/api/v2/receipt/{rec.leaf_id}" in paths


def test_verify_is_called_with_the_hash_of_the_bytes_on_disk(attached_client, http_opener, tmp_path):
    scene = _render_scene(tmp_path, data=b"a real render would go here")
    _wf.witness_render(attached_client, scene)
    _wf.resolve_assurance(attached_client, _state.last_assurance())
    on_disk = hashlib.sha256((tmp_path / "img.png").read_bytes()).hexdigest()
    assert f"/api/v2/verify/{on_disk}" in [r.path for r in http_opener.recorded]


def test_verify_reports_independently_verifiable_as_a_claim_not_a_check(attached_client, tmp_path):
    """THE OTHER CORE HONESTY PROPERTY, and the one with a measured
    reason behind it. On 2026-09-07 /api/v2/verify answered
    independently_verifiable=true for a leaf whose leaf_signature is NULL
    in the witness's own database, because the route derives it from the
    HMAC. So the addon records the claim and never promotes it."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(attached_client, _state.last_assurance())
    assert rec.independently_verifiable_claimed is True
    assert rec.independently_verifiable_checked is False


def test_the_claim_is_still_not_a_check_even_when_a_signature_is_disclosed(sdk_client, http_opener, tmp_path):
    """CONTROL. A signature arriving does not license the addon to say it
    checked one -- it holds no verifying key and performs no ECDSA
    verification anywhere."""
    v2.register_v2_disclosing(http_opener)
    sdk_client.attach(code_paths=[])
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(sdk_client, _state.last_assurance())
    assert rec.signature.present
    assert rec.independently_verifiable_checked is False


def test_an_unknown_content_hash_verifies_as_not_found(attached_client):
    result = _wf.verify_content(attached_client, "f" * 64)
    assert result["found"] is False
    assert result["witnessed"] is False


def test_resolving_does_not_duplicate_the_tracker_entry(attached_client, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert len(_state.assurances()) == 1
    _wf.resolve_assurance(attached_client, _state.last_assurance())
    assert len(_state.assurances()) == 1, "one capture must not become two"


def test_a_queued_capture_is_not_asked_for_a_receipt(sdk_client, http_opener, tmp_path):
    v2.register_v2(http_opener)
    sdk_client.attach(code_paths=[])
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    before = len(http_opener.recorded)
    _wf.resolve_assurance(sdk_client, _state.last_assurance())
    assert len(http_opener.recorded) == before, "there is no leaf to fetch a receipt for"


# ---- canonicalization ---------------------------------------------------

def test_the_client_canonicalization_profile_is_recorded(attached_client, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    assert rec.canonicalization.client == _canonical.CANONICALIZATION_PROFILE


def test_the_server_profile_is_none_because_no_route_returns_it(attached_client, tmp_path):
    """Measured, not assumed: /api/v2/witness and /api/v2/receipt both
    omit canonicalization_profile, and `agrees` is None rather than True
    -- an unanswerable question is not an agreement."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(attached_client, _state.last_assurance())
    assert rec.canonicalization.server is None
    assert rec.canonicalization.source == _a.NOT_DISCLOSED
    assert rec.canonicalization.agrees is None


def test_a_disclosed_profile_is_compared_and_the_divergence_shows(sdk_client, http_opener, tmp_path):
    """CONTROL for the test above. Given a server that DOES disclose,
    the addon compares -- and the comparison currently fails, because
    scruple_api says jcs-1 and the server stamps jcs-2."""
    v2.register_v2_disclosing(http_opener)
    sdk_client.attach(code_paths=[])
    _wf.witness_render(sdk_client, _render_scene(tmp_path))
    rec = _wf.resolve_assurance(sdk_client, _state.last_assurance())
    assert rec.canonicalization.server == v2.SERVER_CANONICALIZATION_PROFILE
    assert rec.canonicalization.agrees is False, (
        "jcs-1 vs jcs-2 is a real divergence in the label; if this ever "
        "passes as True, one side was changed and the report needs updating"
    )


def test_the_client_workflow_hash_is_the_hash_of_what_was_sent(attached_client, http_opener, tmp_path):
    """An auditor holding the leaf can compare this against
    iterations.workflow_hash. The addon cannot: no v2 route returns it."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    graph = _posted(http_opener)["graph"]
    rec = _state.last_assurance()
    assert rec.canonicalization.client_workflow_hash == _canonical.hash_workflow(graph)


def test_a_workflow_with_no_canonical_form_is_refused_rather_than_hashed(attached_client, http_opener, tmp_path, monkeypatch):
    """CONTROL: scruple_api.canonical REFUSES NaN rather than emitting
    null. A leaf committing to a document nobody can reproduce is worse
    than no leaf."""
    monkeypatch.setattr(
        _wf._scene, "build_render_workflow",
        lambda **kw: {"kind": "blender_render", "samples": float("nan")},
    )
    before = len([r for r in http_opener.recorded if r.path == "/api/v2/witness"])
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert _state.last_assurance().state == _a.REFUSED_LOCALLY
    assert len([r for r in http_opener.recorded if r.path == "/api/v2/witness"]) == before


# ---- what leaves the machine -------------------------------------------

def test_the_graph_is_sent_so_the_server_can_compute_a_workflow_hash(attached_client, http_opener, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert isinstance(_posted(http_opener).get("graph"), dict)


def test_an_absolute_path_is_not_sent_to_the_server(attached_client, http_opener, tmp_path):
    """CONTROL for the test above. Sending the graph is new; sending the
    user's directory layout is not part of the deal on a zero-content
    surface."""
    p = tmp_path / "private.blend"
    p.write_bytes(b"BLENDER-fake")
    _wf.witness_save(attached_client, bpy_mock.Scene(), str(p))
    body = _posted(http_opener)
    assert "filepath" not in body["graph"]
    assert body["graph"]["filename"] == "private.blend"
    assert str(tmp_path) not in repr(body), "no absolute path may appear anywhere in the request"


# ---- the fields the addon states rather than guesses -------------------

def test_a_blender_leaf_declares_no_deployment_and_claims_no_standard(attached_client, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    rec = _state.last_assurance()
    assert rec.seal_state == "undeclared"
    assert rec.claims_standard is False


def test_a_blender_leaf_is_not_component_verified(attached_client, tmp_path):
    """H-4 is not closed in this addon: it sends no §4.3 component
    envelope, so no leaf it produces can be component-verified."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert _state.last_assurance().component_verified is False


def test_the_record_serialises_for_the_evidence_file(attached_client, tmp_path):
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    d = _wf.resolve_assurance(attached_client, _state.last_assurance()).to_dict()
    for key in ("state", "assurance_tier", "sentence", "signature", "canonicalization",
                "independently_verifiable_claimed", "independently_verifiable_checked"):
        assert key in d
    assert "explanation" in d["signature"]
    assert d["canonicalization"]["agrees"] is None
