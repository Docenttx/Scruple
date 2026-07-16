"""Operator surface tests — invoke with the mock bpy in place.

These tests install the bpy mock, monkeypatch the client factory to
route through http_mock, and run the operators end-to-end. They cover
the flows that only appear under the bpy dependency (invoke_confirm,
report levels, bl_idname registration).
"""

from __future__ import annotations

import importlib
import sys

import pytest

from tests.mocks import bpy_mock, http_mock


ADDON_MODULES = (
    "operators.auth",
    "operators.witness",
    "operators.checkpoint",
    "operators.c2pa",
    "operators.chain_lock",
    "operators.open_receipt",
    "operators.payment_setup",
    "panels.main",
    "lib.preferences",
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


def _cfg_with_pm():
    return {
        "payment_method": {"brand": "Visa", "last4": "4242"},
        "prices": {
            "checkpoint": 500, "finalize": 1000,
            "chain-lock-basic": 5000, "chain-lock-pinned": 10000,
        },
    }


def test_witness_now_operator_requires_signin(with_bpy, fresh_state, monkeypatch):
    import operators.witness as op_mod
    from lib import scruple_client as _client
    monkeypatch.setattr(_client, "from_preferences", lambda: None)
    op = op_mod.SCRUPLE_OT_witness_now()
    result = op.execute(sys.modules["bpy"].context)
    assert result == {"CANCELLED"}
    assert any("Not signed in" in msg for _levels, msg in op.reports_recorded)


def test_witness_now_operator_reports_success(with_bpy, fresh_state, monkeypatch, tmp_path):
    import operators.witness as op_mod
    from lib import scruple_client as _client
    opener = http_mock.new()
    opener.register("POST", "/api/projects", {"ok": True, "id": 1, "name": "X", "status": "unlocked"})
    opener.register("POST", "/api/witness/cad", {
        "ok": True, "iteration": {"id": 1}, "leafHash": "leaf-abc" + "d" * 50,
        "runSequence": 1, "machineManifestHash": "d" * 64,
    })
    client = _client.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)
    monkeypatch.setattr(_client, "from_preferences", lambda: client)

    ctx = sys.modules["bpy"].context
    ctx.scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    op = op_mod.SCRUPLE_OT_witness_now()
    result = op.execute(ctx)
    assert result == {"FINISHED"}


def test_checkpoint_operator_charges_and_locks(with_bpy, fresh_state, monkeypatch):
    from lib import scruple_client as _client
    from lib import state as _state
    import operators.checkpoint as op_mod

    opener = http_mock.new()
    opener.register("GET", "/api/stripe/config", _cfg_with_pm())
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_ok", "status": "succeeded"})
    opener.register("POST", "/api/lock/checkpoint", {"ok": True, "preScrId": "SCR_pre", "merkleRoot": "a" * 64})
    client = _client.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)
    monkeypatch.setattr(_client, "from_preferences", lambda: client)

    _state.get().active_project_id = 42
    op = op_mod.SCRUPLE_OT_checkpoint()
    op._config = _cfg_with_pm()
    result = op.execute(sys.modules["bpy"].context)
    assert result == {"FINISHED"}
    lock_calls = [r for r in opener.recorded if r.path == "/api/lock/checkpoint"]
    assert len(lock_calls) == 1


def test_c2pa_operator_charges_and_locks(with_bpy, fresh_state, monkeypatch):
    from lib import scruple_client as _client
    from lib import state as _state
    import operators.c2pa as op_mod

    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_c2pa", "status": "succeeded"})
    opener.register("POST", "/api/lock/local", {"ok": True, "scrId": "SCR_final", "merkleRoot": "b" * 64})
    client = _client.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)
    monkeypatch.setattr(_client, "from_preferences", lambda: client)

    _state.get().active_project_id = 42
    op = op_mod.SCRUPLE_OT_c2pa_sign()
    op._config = _cfg_with_pm()
    result = op.execute(sys.modules["bpy"].context)
    assert result == {"FINISHED"}
    lock_calls = [r for r in opener.recorded if r.path == "/api/lock/local"]
    assert len(lock_calls) == 1


def test_chain_lock_operator_uses_tier(with_bpy, fresh_state, monkeypatch):
    from lib import scruple_client as _client
    from lib import state as _state
    import operators.chain_lock as op_mod

    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_chain", "status": "succeeded"})
    opener.register("POST", "/api/lock/chain", {
        "ok": True, "scrId": "SCR_chain", "proofTxId": "rvn_tx", "tier": "pinned",
    })
    client = _client.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)
    monkeypatch.setattr(_client, "from_preferences", lambda: client)

    _state.get().active_project_id = 42
    op = op_mod.SCRUPLE_OT_chain_lock()
    op._config = _cfg_with_pm()
    op.tier = "pinned"
    result = op.execute(sys.modules["bpy"].context)
    assert result == {"FINISHED"}
    lock_calls = [r for r in opener.recorded if r.path == "/api/lock/chain"]
    assert lock_calls[0].body["tier"] == "pinned"


def test_operator_bl_idnames_present(with_bpy):
    import operators.auth as a
    import operators.witness as w
    import operators.checkpoint as c
    import operators.c2pa as p
    import operators.chain_lock as ch
    import operators.open_receipt as r
    import operators.payment_setup as ps
    assert a.SCRUPLE_OT_sign_in.bl_idname == "scruple.sign_in"
    assert a.SCRUPLE_OT_sign_out.bl_idname == "scruple.sign_out"
    assert w.SCRUPLE_OT_witness_now.bl_idname == "scruple.witness_now"
    assert c.SCRUPLE_OT_checkpoint.bl_idname == "scruple.checkpoint"
    assert p.SCRUPLE_OT_c2pa_sign.bl_idname == "scruple.c2pa_sign"
    assert ch.SCRUPLE_OT_chain_lock.bl_idname == "scruple.chain_lock"
    assert r.SCRUPLE_OT_open_receipt.bl_idname == "scruple.open_receipt"
    assert ps.SCRUPLE_OT_setup_payment.bl_idname == "scruple.setup_payment"


def test_register_and_unregister_do_not_raise(with_bpy):
    import operators.auth as a
    a.register()
    a.unregister()
