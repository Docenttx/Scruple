"""Payment flow tests — off-session PaymentIntent orchestration."""

from __future__ import annotations

import pytest

from lib import payment as _payment
from lib import scruple_client as _client_mod
from tests.mocks import http_mock


def _client(opener):
    return _client_mod.ScrupleClient(base_url="https://scruple.test", api_key="sk_test", opener=opener)


def test_has_payment_method_true_when_config_carries_pm():
    cfg = {"payment_method": {"brand": "visa", "last4": "4242"}}
    assert _payment.has_payment_method(cfg)
    assert _payment.payment_method_summary(cfg) == "Visa ending 4242"


def test_has_payment_method_false_when_missing():
    assert not _payment.has_payment_method({})
    assert _payment.payment_method_summary({}) is None


def test_price_cents_prefers_server_over_default():
    cfg = {"prices": {"checkpoint": 750}}
    assert _payment.price_cents_for("checkpoint", cfg) == 750


def test_price_cents_falls_back_to_default():
    assert _payment.price_cents_for("chain-lock-pinned") == 10000


def test_confirm_message_with_pm():
    msg = _payment.build_confirm_message("checkpoint", 500, "Visa ending 4242")
    assert "5.00" in msg
    assert "Visa ending 4242" in msg


def test_charge_requires_pm_on_file():
    opener = http_mock.new()
    opener.register("GET", "/api/stripe/config", {})
    result = _payment.charge(_client(opener), project_id=1, action="checkpoint", confirm=lambda _m: True)
    assert not result.ok
    assert "payment method" in result.error.lower()


def test_charge_cancelled_by_confirm_dialog():
    opener = http_mock.new()
    result = _payment.charge(
        _client(opener), project_id=1, action="checkpoint",
        confirm=lambda _m: False,
        config={"payment_method": {"brand": "Visa", "last4": "4242"}, "prices": {"checkpoint": 500}},
    )
    assert not result.ok
    assert result.error == "Cancelled by user"


def test_charge_happy_path_returns_pi():
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {
        "paymentIntentId": "pi_ok", "status": "succeeded",
    })
    result = _payment.charge(
        _client(opener), project_id=42, action="checkpoint",
        confirm=lambda _m: True,
        config={"payment_method": {"brand": "Visa", "last4": "4242"}, "prices": {"checkpoint": 500}},
    )
    assert result.ok
    assert result.payment_intent_id == "pi_ok"
    body = opener.recorded[0].body
    assert body["projectId"] == 42
    assert body["action"] == "checkpoint"


def test_charge_requires_action_surfaces_pi_and_url():
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {
        "paymentIntentId": "pi_needs3ds", "status": "requires_action",
        "next_action_url": "https://scruple.ai/pay/pi_needs3ds",
    })
    result = _payment.charge(
        _client(opener), project_id=42, action="checkpoint",
        confirm=lambda _m: True,
        config={"payment_method": {"brand": "Visa", "last4": "4242"}, "prices": {"checkpoint": 500}},
    )
    assert not result.ok
    assert result.payment_intent_id == "pi_needs3ds"
    assert result.requires_action_url == "https://scruple.ai/pay/pi_needs3ds"


def test_charge_maps_server_error_to_error_string():
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"error": "card_declined"}, status=402)
    result = _payment.charge(
        _client(opener), project_id=42, action="checkpoint",
        confirm=lambda _m: True,
        config={"payment_method": {"brand": "Visa", "last4": "4242"}, "prices": {"checkpoint": 500}},
    )
    assert not result.ok
    assert "402" in result.error
