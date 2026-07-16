"""Paid-action spine tests — charge -> submit_lock -> record receipt."""

from __future__ import annotations

from lib import paid_action as _paid
from lib import payment as _payment
from lib import scruple_client as _client_mod
from lib import state as _state
from tests.mocks import http_mock


def _client(opener):
    return _client_mod.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)


def _cfg_with_pm():
    return {
        "payment_method": {"brand": "Visa", "last4": "4242"},
        "prices": {
            "checkpoint": 500, "finalize": 1000,
            "chain-lock-basic": 5000, "chain-lock-pinned": 10000,
        },
    }


def test_happy_path_charges_then_locks(fresh_state):
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_ok", "status": "succeeded"})
    opener.register("POST", "/api/lock/checkpoint", {
        "ok": True, "preScrId": "SCR_pre", "merkleRoot": "abcd" * 16,
    })
    client = _client(opener)
    def _submit(c, p, pi):
        return c.lock_checkpoint(p, pi)
    result = _paid.run_paid_action(
        client, action=_payment.ACTION_CHECKPOINT, project_id=42,
        submit_lock=_submit, confirm=lambda _m: True, config=_cfg_with_pm(),
    )
    assert result.ok
    assert result.payment_intent_id == "pi_ok"
    assert result.lock_response["preScrId"] == "SCR_pre"
    assert _state.get().recent_receipts[0]["payment_intent_id"] == "pi_ok"


def test_cancelled_returns_flag_and_no_charge(fresh_state):
    opener = http_mock.new()
    client = _client(opener)
    result = _paid.run_paid_action(
        client, action=_payment.ACTION_CHECKPOINT, project_id=42,
        submit_lock=lambda c, p, pi: {"ok": True},
        confirm=lambda _m: False, config=_cfg_with_pm(),
    )
    assert not result.ok
    assert result.cancelled


def test_no_payment_method_surfaces_setup_prompt(fresh_state):
    opener = http_mock.new()
    client = _client(opener)
    result = _paid.run_paid_action(
        client, action=_payment.ACTION_CHECKPOINT, project_id=42,
        submit_lock=lambda c, p, pi: {"ok": True},
        confirm=lambda _m: True, config={},
    )
    assert not result.ok
    assert "scruple.ai" in (result.error or "").lower()


def test_lock_failure_after_charge_reports_pi_for_manual_reconcile(fresh_state):
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_ok", "status": "succeeded"})
    opener.register("POST", "/api/lock/checkpoint", {"error": "database offline"}, status=500)
    client = _client(opener)
    result = _paid.run_paid_action(
        client, action=_payment.ACTION_CHECKPOINT, project_id=42,
        submit_lock=lambda c, p, pi: c.lock_checkpoint(p, pi),
        confirm=lambda _m: True, config=_cfg_with_pm(),
    )
    assert not result.ok
    assert result.payment_intent_id == "pi_ok"
    assert "Lock submission failed" in (result.error or "")
