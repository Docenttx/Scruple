"""Payment flow — off-session metered charge for paid actions.

Blender's UI is native (no HTML), so the card-entry step lives on
scruple.ai. In-Blender we:

  1. Fetch stripe/config to learn whether a payment method is on file
     (and the tier prices, so we can show accurate cents in the confirm
     dialog).
  2. Fire an in-Blender confirmation ("Charge $5 to card ending 4242?").
  3. POST /api/stripe/payment-intent with the target action; the server
     charges the on-file card off-session and returns a PaymentIntent ID.
  4. Post the resulting pi_ into the target lock endpoint. The lock
     endpoint has its own witness-server-gated verification path.

If Stripe returns `requires_action` the caller surfaces a message that
points the user at scruple.ai/pay/<pi> to finish 3DS, and the URL-scheme
handler resumes the operator when the callback lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from . import scruple_client as _client_mod
from . import logging as _log

ACTION_CHECKPOINT = "checkpoint"
ACTION_C2PA = "finalize"
ACTION_CHAIN_BASIC = "chain-lock-basic"
ACTION_CHAIN_PINNED = "chain-lock-pinned"

ACTION_LABELS: Dict[str, str] = {
    ACTION_CHECKPOINT: "Checkpoint",
    ACTION_C2PA: "C2PA sign",
    ACTION_CHAIN_BASIC: "Chain-lock (basic)",
    ACTION_CHAIN_PINNED: "Chain-lock (pinned)",
}

DEFAULT_PRICE_CENTS: Dict[str, int] = {
    ACTION_CHECKPOINT: 500,
    ACTION_C2PA: 1000,
    ACTION_CHAIN_BASIC: 5000,
    ACTION_CHAIN_PINNED: 10000,
}


@dataclass
class PaymentResult:
    ok: bool
    payment_intent_id: Optional[str] = None
    requires_action_url: Optional[str] = None
    error: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


def price_cents_for(action: str, config: Optional[Dict[str, Any]] = None) -> int:
    """Ask the server for the live price; fall back to the addon's
    defaults so the confirm dialog still shows a number if config is
    unreachable."""
    if config:
        prices = config.get("prices") if isinstance(config, dict) else None
        if isinstance(prices, dict):
            v = prices.get(action)
            if isinstance(v, (int, float)) and v > 0:
                return int(v)
    return DEFAULT_PRICE_CENTS.get(action, 0)


def format_price(cents: int) -> str:
    return f"${cents / 100:.2f}"


def payment_method_summary(config: Dict[str, Any]) -> Optional[str]:
    """Return "Visa ending 4242" or None if no PM on file."""
    if not isinstance(config, dict):
        return None
    pm = config.get("payment_method") or config.get("paymentMethod")
    if not isinstance(pm, dict):
        return None
    brand = str(pm.get("brand") or pm.get("card_brand") or "card").capitalize()
    last4 = str(pm.get("last4") or "").strip()
    if not last4:
        return brand
    return f"{brand} ending {last4}"


def has_payment_method(config: Dict[str, Any]) -> bool:
    return payment_method_summary(config) is not None


def build_confirm_message(
    action: str,
    price_cents: int,
    pm_summary: Optional[str],
) -> str:
    label = ACTION_LABELS.get(action, action)
    price = format_price(price_cents)
    if pm_summary:
        return f"Charge {price} to {pm_summary} for {label}?"
    return f"Charge {price} for {label}?"


def charge(
    client: _client_mod.ScrupleClient,
    *,
    project_id: int,
    action: str,
    confirm: Callable[[str], bool],
    config: Optional[Dict[str, Any]] = None,
) -> PaymentResult:
    """Full off-session flow: confirm, charge, hand back the pi_ID."""
    if config is None:
        try:
            config = client.get_payment_methods()
        except Exception as e:
            _log.warn(f"stripe/config unreachable: {e}")
            config = {}
    if not has_payment_method(config):
        return PaymentResult(
            ok=False,
            error="No payment method on file. Set one up on scruple.ai first.",
        )
    price = price_cents_for(action, config)
    pm_summary = payment_method_summary(config)
    if not confirm(build_confirm_message(action, price, pm_summary)):
        return PaymentResult(ok=False, error="Cancelled by user")

    try:
        resp = client.create_payment_intent(project_id, action=action)
    except _client_mod.ScrupleClientError as e:
        return PaymentResult(ok=False, error=str(e))

    if not isinstance(resp, dict):
        return PaymentResult(ok=False, error="Empty response from payment-intent")

    pi = resp.get("paymentIntentId") or resp.get("payment_intent_id") or resp.get("id")
    status = resp.get("status") or ""
    if status == "requires_action":
        return PaymentResult(
            ok=False,
            payment_intent_id=pi,
            requires_action_url=resp.get("next_action_url") or resp.get("hosted_action_url"),
            error="Card needs verification. Finish on scruple.ai/pay/<pi>.",
            raw=resp,
        )
    if not pi:
        return PaymentResult(ok=False, error=f"No payment_intent id in response: {resp!r}", raw=resp)
    if status and status not in {"succeeded", "requires_capture", "processing"}:
        return PaymentResult(ok=False, payment_intent_id=pi, error=f"Unexpected status: {status}", raw=resp)
    return PaymentResult(ok=True, payment_intent_id=pi, raw=resp)
