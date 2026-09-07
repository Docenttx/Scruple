"""Payment -- the SDK's module, driven by a Client.

Same behaviours the addon's payment.py was tested for; gap.json marks
this pair `differs: false` ("functionally the same module"). The one
difference is documentation honesty, and it is worth restating here
because it governs what these tests can prove: `/api/stripe/*`
authenticates with a browser session cookie, not a bearer key, so a
plugin gets a 401 against the deployed server. These tests run against a
mock that answers as if it did not. They prove the flow is correctly
wired; they do not prove a charge works headless, and nothing can until
a bearer-compatible payment route exists.
"""

from __future__ import annotations

from scruple_host_sdk import payment as _payment
from tests.mocks import v2


def test_has_payment_method_true_when_config_carries_pm():
    cfg = {"payment_method": {"brand": "visa", "last4": "4242"}}
    assert _payment.has_payment_method(cfg)
    assert _payment.payment_method_summary(cfg) == "Visa ending 4242"


def test_has_payment_method_false_when_missing():
    assert not _payment.has_payment_method({})
    assert _payment.payment_method_summary({}) is None


def test_price_cents_prefers_server_over_default():
    assert _payment.price_cents_for("checkpoint", {"prices": {"checkpoint": 750}}) == 750


def test_price_cents_falls_back_to_default():
    assert _payment.price_cents_for("chain-lock-pinned") == 10000


def test_confirm_message_with_pm():
    msg = _payment.build_confirm_message("checkpoint", 500, "Visa ending 4242")
    assert "5.00" in msg
    assert "Visa ending 4242" in msg


def test_charge_requires_pm_on_file(sdk_client, http_opener):
    http_opener.register("GET", "/api/stripe/config", {})
    result = _payment.charge(sdk_client, project_id=1, action="finalize", confirm=lambda _m: True)
    assert not result.ok
    assert "payment method" in result.error.lower()


def test_charge_cancelled_by_confirm_dialog(sdk_client, http_opener):
    v2.register_stripe(http_opener)
    result = _payment.charge(sdk_client, project_id=1, action="finalize", confirm=lambda _m: False)
    assert not result.ok
    assert result.error == "Cancelled by user"
    assert [r for r in http_opener.recorded if r.path == "/api/stripe/payment-intent"] == []


def test_charge_happy_path_returns_pi(sdk_client, http_opener):
    v2.register_stripe(http_opener)
    result = _payment.charge(sdk_client, project_id=42, action="finalize", confirm=lambda _m: True)
    assert result.ok
    assert result.payment_intent_id == "pi_ok"
    body = [r for r in http_opener.recorded if r.path == "/api/stripe/payment-intent"][0].body
    assert body["projectId"] == 42
    assert body["action"] == "finalize"


def test_charge_requires_action_surfaces_pi_and_url(sdk_client, http_opener):
    v2.register_stripe(http_opener)
    http_opener.register("POST", "/api/stripe/payment-intent", {
        "paymentIntentId": "pi_needs3ds", "status": "requires_action",
        "next_action_url": "https://scruple.ai/pay/pi_needs3ds",
    })
    result = _payment.charge(sdk_client, project_id=42, action="finalize", confirm=lambda _m: True)
    assert not result.ok
    assert result.payment_intent_id == "pi_needs3ds"
    assert result.requires_action_url == "https://scruple.ai/pay/pi_needs3ds"


def test_charge_maps_server_error_to_error_string(sdk_client, http_opener):
    v2.register_stripe(http_opener)
    http_opener.register("POST", "/api/stripe/payment-intent", {"error": "card_declined"}, status=402)
    result = _payment.charge(sdk_client, project_id=42, action="finalize", confirm=lambda _m: True)
    assert not result.ok
    assert "402" in result.error


def test_a_failed_charge_is_never_queued(sdk_client, http_opener):
    """Deliberate, and different from a witness: silently retrying a
    finance-adjacent request is a worse kind of unsafe."""
    v2.register_stripe(http_opener)
    http_opener.register("POST", "/api/stripe/payment-intent", {"error": "boom"}, status=503)
    result = _payment.charge(sdk_client, project_id=42, action="finalize", confirm=lambda _m: True)
    assert not result.ok
    assert sdk_client.queue_depth == 0
