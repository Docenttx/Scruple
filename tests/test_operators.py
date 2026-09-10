"""Operator surface -- invoked with the bpy mock in place.

This file absorbs tests/test_paid_action.py. lib/paid_action.py's spine
was charge -> call a per-operator `submit_lock` callable -> record a
receipt; under v2 there is one endpoint and the operators differ only in
the modality list, so the callable seam is gone and there is nothing
left to test between the operator and the SDK. The four behaviours that
file covered -- charge then lock, cancellation, no payment method on
file, and a lock that fails after a successful charge -- are each a test
below, at the operator level where they now live.
"""

from __future__ import annotations

import importlib
import sys

import pytest

from tests.mocks import bpy_mock, v2


ADDON_MODULES = (
    "operators.auth",
    "operators.witness",
    "operators.witness_export",
    "operators.checkpoint",
    "operators.c2pa",
    "operators.chain_lock",
    "operators.open_receipt",
    "operators.payment_setup",
    "operators.resume_payment",
    "panels.main",
    "adapter.preferences",
)


@pytest.fixture
def with_bpy():
    bpy_mock.install()
    bpy_mock.reset()
    for name in ADDON_MODULES:
        if name in sys.modules:
            importlib.reload(sys.modules[name])
    yield sys.modules["bpy"]
    bpy_mock.reset()
    sys.modules.pop("bpy", None)
    for name in ADDON_MODULES:
        if name in sys.modules:
            importlib.reload(sys.modules[name])


def _messages(op):
    return [msg for _levels, msg in op.reports_recorded]


# ---- witness ------------------------------------------------------------

def test_witness_now_operator_requires_signin(with_bpy, fresh_state, monkeypatch):
    import operators.witness as op_mod
    from adapter import sdk as _sdk
    monkeypatch.setattr(_sdk, "get_client", lambda: None)
    op = op_mod.SCRUPLE_OT_witness_now()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert any("Not signed in" in m for m in _messages(op))


def test_witness_now_operator_reports_witnessed(with_bpy, attached_client, http_opener, tmp_path):
    import operators.witness as op_mod
    ctx = sys.modules["bpy"].context
    ctx.scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    op = op_mod.SCRUPLE_OT_witness_now()
    assert op.execute(ctx) == {"FINISHED"}
    assert any("Witnessed." in m for m in _messages(op))


def test_witness_now_operator_says_queued_when_the_server_is_down(
    with_bpy, attached_client, http_opener, tmp_path,
):
    """D-8 at the UI layer: an undelivered capture must not read as
    'Witnessed.'"""
    import operators.witness as op_mod
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    ctx = sys.modules["bpy"].context
    ctx.scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    op = op_mod.SCRUPLE_OT_witness_now()
    op.execute(ctx)
    assert any("queued" in m.lower() for m in _messages(op))
    assert not any("Witnessed." in m for m in _messages(op))


def test_witness_now_operator_says_not_witnessed_on_a_delivered_refusal(
    with_bpy, sdk_client, http_opener, tmp_path,
):
    import operators.witness as op_mod
    v2.register_v2(http_opener, witnessed=False)
    sdk_client.attach(code_paths=[])
    ctx = sys.modules["bpy"].context
    ctx.scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    op = op_mod.SCRUPLE_OT_witness_now()
    op.execute(ctx)
    assert any("Not witnessed" in m for m in _messages(op))


def test_witness_export_requires_a_mime_for_other(with_bpy, attached_client, http_opener, tmp_path):
    """Property 1 at the UI layer: 'Other' with no declared type is a
    refusal, not an octet-stream upload."""
    import operators.witness_export as op_mod
    p = tmp_path / "thing.xyz"
    p.write_bytes(b"whatever")
    op = op_mod.SCRUPLE_OT_witness_export()
    op.filepath = str(p)
    op.format = "other"
    op.mime = ""
    op.execute(sys.modules["bpy"].context)
    assert [r for r in http_opener.recorded if r.path == "/api/v2/witness"] == []
    assert any("mime" in m.lower() for m in _messages(op))


def test_witness_export_accepts_a_declared_mime(with_bpy, attached_client, http_opener, tmp_path):
    import operators.witness_export as op_mod
    p = tmp_path / "thing.xyz"
    p.write_bytes(b"whatever")
    op = op_mod.SCRUPLE_OT_witness_export()
    op.filepath = str(p)
    op.format = "other"
    op.mime = "model/x-thing"
    assert op.execute(sys.modules["bpy"].context) == {"FINISHED"}
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    assert posted["mime"] == "model/x-thing"


# ---- paid actions: the spine that used to be lib/paid_action.py ---------

def _witness_one(client, tmp_path, name="img.png"):
    """Produce a leaf for a paid action to mark. v2 marks a leaf, so a
    paid operator with no prior witness has nothing to act on."""
    from adapter import flow as _wf
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / name)
    (tmp_path / name).write_bytes(b"pixels")
    return _wf.witness_render(client, scene)


def test_local_lock_charges_then_marks(with_bpy, attached_client, http_opener, tmp_path):
    import operators.c2pa as op_mod
    v2.register_stripe(http_opener)
    outcome = _witness_one(attached_client, tmp_path)

    op = op_mod.SCRUPLE_OT_c2pa_sign()
    assert op.execute(sys.modules["bpy"].context) == {"FINISHED"}

    charges = [r for r in http_opener.recorded if r.path == "/api/stripe/payment-intent"]
    marks = [r for r in http_opener.recorded if r.path == "/api/v2/mark"]
    assert len(charges) == 1
    assert len(marks) == 1
    assert marks[0].body["leaf_id"] == outcome.leaf_id
    assert marks[0].body["modalities"] == []
    assert marks[0].body["payment_intent_id"] == "pi_ok"


def test_chain_lock_charges_then_marks_with_tier(with_bpy, attached_client, http_opener, tmp_path):
    import operators.chain_lock as op_mod
    v2.register_stripe(http_opener)
    _witness_one(attached_client, tmp_path)

    op = op_mod.SCRUPLE_OT_chain_lock()
    op.tier = "pinned"
    assert op.execute(sys.modules["bpy"].context) == {"FINISHED"}
    marks = [r for r in http_opener.recorded if r.path == "/api/v2/mark"]
    assert marks[0].body["modalities"] == ["chain"]
    assert marks[0].body["chain_tier"] == "pinned"


def test_a_paid_action_with_no_leaf_charges_nothing(with_bpy, attached_client, http_opener, tmp_path):
    """The v1 gate was 'is there an active project'. v2 marks a leaf, so
    the gate is 'is there a leaf' -- and it fires before the charge."""
    import operators.c2pa as op_mod
    v2.register_stripe(http_opener)
    op = op_mod.SCRUPLE_OT_c2pa_sign()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert [r for r in http_opener.recorded if r.path == "/api/stripe/payment-intent"] == []


def test_no_payment_method_surfaces_the_setup_prompt_and_charges_nothing(
    with_bpy, attached_client, http_opener, tmp_path,
):
    import operators.c2pa as op_mod
    http_opener.register("GET", "/api/stripe/config", {})
    _witness_one(attached_client, tmp_path)
    op = op_mod.SCRUPLE_OT_c2pa_sign()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert any("scruple.ai" in m.lower() for m in _messages(op))
    assert [r for r in http_opener.recorded if r.path == "/api/stripe/payment-intent"] == []


def test_a_mark_that_fails_after_a_charge_reports_the_payment_intent(
    with_bpy, attached_client, http_opener, tmp_path,
):
    """The money moved and the modality did not. That has to be visible
    or it is a silent loss."""
    import operators.chain_lock as op_mod
    v2.register_stripe(http_opener)
    v2.register_v2(http_opener, modalities_available=["local"])  # chain refused
    _witness_one(attached_client, tmp_path)

    op = op_mod.SCRUPLE_OT_chain_lock()
    op.tier = "pinned"
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert any("pi_ok" in m for m in _messages(op))
    assert [r for r in http_opener.recorded if r.path == "/api/v2/mark"] == []


def test_outstanding_modalities_are_reported_not_hidden(
    with_bpy, attached_client, http_opener, tmp_path,
):
    import operators.chain_lock as op_mod
    v2.register_stripe(http_opener)
    v2.register_v2(http_opener, modalities_applied=[])
    _witness_one(attached_client, tmp_path)

    op = op_mod.SCRUPLE_OT_chain_lock()
    op.tier = "basic"
    op.execute(sys.modules["bpy"].context)
    assert any("Outstanding" in m for m in _messages(op))


# ---- checkpoint: refused, loudly ----------------------------------------

def test_checkpoint_refuses_and_touches_no_route(with_bpy, attached_client, http_opener):
    """/api/lock/checkpoint has no v2 equivalent. The button explains
    itself and charges nothing; the control is that the opener recorded
    no request at all."""
    import operators.checkpoint as op_mod
    before = len(http_opener.recorded)
    op = op_mod.SCRUPLE_OT_checkpoint()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert any("no /api/v2 equivalent" in m for m in _messages(op))
    assert len(http_opener.recorded) == before


# ---- registration -------------------------------------------------------

def test_operator_bl_idnames_present(with_bpy):
    """Every bl_idname is unchanged from the v1 addon, so a saved keymap
    still resolves after the migration."""
    import operators.auth as a
    import operators.witness as w
    import operators.witness_export as we
    import operators.checkpoint as c
    import operators.c2pa as p
    import operators.chain_lock as ch
    import operators.open_receipt as r
    import operators.payment_setup as ps
    import operators.resume_payment as rp
    assert a.SCRUPLE_OT_sign_in.bl_idname == "scruple.sign_in"
    assert a.SCRUPLE_OT_sign_out.bl_idname == "scruple.sign_out"
    assert w.SCRUPLE_OT_witness_now.bl_idname == "scruple.witness_now"
    assert we.SCRUPLE_OT_witness_export.bl_idname == "scruple.witness_export"
    assert c.SCRUPLE_OT_checkpoint.bl_idname == "scruple.checkpoint"
    assert p.SCRUPLE_OT_c2pa_sign.bl_idname == "scruple.c2pa_sign"
    assert ch.SCRUPLE_OT_chain_lock.bl_idname == "scruple.chain_lock"
    assert r.SCRUPLE_OT_open_receipt.bl_idname == "scruple.open_receipt"
    assert ps.SCRUPLE_OT_setup_payment.bl_idname == "scruple.setup_payment"
    assert rp.SCRUPLE_OT_resume_payment.bl_idname == "scruple.resume_payment"


def test_register_and_unregister_do_not_raise(with_bpy):
    import operators.auth as a
    a.register()
    a.unregister()


def test_the_addon_entry_point_registers_every_module(with_bpy, fresh_state):
    """__init__.register() is what Blender calls. It imports the adapter
    package, which is what puts vendor/ on sys.path."""
    import __init__ as addon
    importlib.reload(addon)
    addon.register()
    addon.unregister()


# ---- WO-B3: the verify operator ----------------------------------------

def test_verify_last_fetches_the_receipt_and_reports_the_claim_as_a_claim(
    attached_client, http_opener, tmp_path, bpy_installed
):
    from tests.conftest import reload_addon_modules
    reload_addon_modules(["operators.verify"])
    from adapter import flow as _wf
    from adapter import state as _state
    from operators import verify as _op

    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "v.png")
    (tmp_path / "v.png").write_bytes(b"pixels")
    _wf.witness_render(attached_client, scene)

    op = _op.SCRUPLE_OT_verify_last()
    op.report = lambda level, msg: op.reported.append((level, msg))
    op.reported = []
    assert op.execute(None) == {"FINISHED"}

    text = " | ".join(m for _, m in op.reported)
    assert "/api/v2/receipt/" in " ".join(r.path for r in http_opener.recorded)
    assert "scruple.ai says independently verifiable" in text
    assert "This addon has not checked it" in text


def test_verify_last_refuses_when_there_is_no_leaf_to_verify(
    attached_client, tmp_path, bpy_installed, fresh_state
):
    """CONTROL: a queued or refused capture has no leaf id, and the
    operator must say so rather than fetching a receipt for None."""
    from tests.conftest import reload_addon_modules
    reload_addon_modules(["operators.verify"])
    from adapter import assurance as _a
    from adapter import state as _state
    from operators import verify as _op

    _state.record_assurance(_a.refused("no baseline", kind="render"))
    op = _op.SCRUPLE_OT_verify_last()
    op.report = lambda level, msg: op.reported.append((level, msg))
    op.reported = []
    assert op.execute(None) == {"CANCELLED"}
    assert "Refused here" in " ".join(m for _, m in op.reported)


def test_the_panel_row_never_says_witnessed_for_a_capture_that_was_not(bpy_installed):
    from tests.conftest import reload_addon_modules
    reload_addon_modules(["panels.main"])
    from adapter import assurance as _a
    from panels import main as _panel

    witnessed = _a.LeafAssurance(state=_a.WITNESSED, kind="render", mime="image/png", leaf_id="7")
    assert "witnessed" in _panel.assurance_line(witnessed)
    # CONTROL: every other state must NOT produce the word "witnessed".
    for state in (_a.QUEUED, _a.REJECTED, _a.REFUSED_LOCALLY):
        rec = _a.LeafAssurance(state=state, kind="render", mime="image/png", leaf_id="7")
        assert "witnessed" not in _panel.assurance_line(rec), state
    # `delivered not witnessed` contains the word, and must read as a
    # negation rather than as a claim.
    dnw = _a.LeafAssurance(state=_a.DELIVERED_NOT_WITNESSED, kind="render", mime="image/png", leaf_id="7")
    assert "not witnessed" in _panel.assurance_line(dnw)


def test_the_panel_shows_the_tier_and_it_is_undisclosed_today(bpy_installed):
    from tests.conftest import reload_addon_modules
    reload_addon_modules(["panels.main"])
    from adapter import assurance as _a
    from panels import main as _panel

    rec = _a.LeafAssurance(state=_a.WITNESSED, kind="render", mime="image/png", leaf_id="7")
    line = _panel.assurance_line(rec)
    assert "undisclosed" in line
    assert "verified" not in line


# ---- WO-F1: no base URL means no request, not a request to production ---
#
# ⚑ Finding E7-2, second half. `get_base_url()` used to fall through to the
# SDK's default, `https://scruple.ai`. Three operators build a URL out of it
# and one of them opens a browser at it, so an addon nobody had configured
# would have sent a user to the live service without ever naming it. Each
# refuses now, and the refusal says where to set it.

def _no_base_url(monkeypatch):
    from adapter import preferences as _prefs
    monkeypatch.setattr(_prefs, "get_base_url", lambda: "")


def test_sign_in_refuses_without_a_base_url_and_opens_no_browser(
    with_bpy, monkeypatch,
):
    import operators.auth as op_mod

    opened = []
    monkeypatch.setattr(op_mod, "_run_signin", lambda base, cb: opened.append(base))
    _no_base_url(monkeypatch)

    op = op_mod.SCRUPLE_OT_sign_in()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert opened == [], "the handshake would have opened a browser at production"
    assert any("base URL" in m for m in _messages(op))


def test_setup_payment_refuses_without_a_base_url(with_bpy, monkeypatch):
    import operators.payment_setup as op_mod

    opened = []
    monkeypatch.setattr(op_mod.webbrowser, "open", lambda url: opened.append(url))
    _no_base_url(monkeypatch)

    op = op_mod.SCRUPLE_OT_setup_payment()
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert opened == []
    assert any("base URL" in m for m in _messages(op))


def test_open_receipt_refuses_without_a_base_url(with_bpy, monkeypatch, fresh_state):
    import operators.open_receipt as op_mod

    opened = []
    monkeypatch.setattr(op_mod.webbrowser, "open", lambda url: opened.append(url))
    _no_base_url(monkeypatch)

    op = op_mod.SCRUPLE_OT_open_receipt()
    op.project_id = 7
    assert op.execute(sys.modules["bpy"].context) == {"CANCELLED"}
    assert opened == []
    assert any("base URL" in m for m in _messages(op))


def test_a_configured_base_url_still_opens_the_browser(with_bpy, monkeypatch):
    """CONTROL. The refusal must be about the missing value, not about the
    operator having been broken -- with a base URL set, the same call goes
    through and the URL it opens is the configured one."""
    import operators.payment_setup as op_mod
    from adapter import preferences as _prefs

    opened = []
    monkeypatch.setattr(op_mod.webbrowser, "open", lambda url: opened.append(url))
    monkeypatch.setattr(_prefs, "get_base_url", lambda: "http://127.0.0.1:3902")

    op = op_mod.SCRUPLE_OT_setup_payment()
    assert op.execute(sys.modules["bpy"].context) == {"FINISHED"}
    assert opened == ["http://127.0.0.1:3902/settings/payment"]
