"""Off-session payment flow for priced modalities.

Ported from Blender's payment.py, which is 75-85% textually identical to
Meshroom's -- same four-step shape (fetch config, confirm in-host,
create the intent, hand the intent id to the caller). The card-entry UI
lives on scruple.ai in every host because none of them have HTML; this
module never sees a card number.

GAP -- STATED PLAINLY, NOT STUBBED SILENTLY:

openapi-v2.yaml's `POST /v2/mark` accepts a `payment_intent_id`, but
`/v2` exposes no route to create one. The only routes that create or
confirm a Stripe PaymentIntent in the deployed server are
`/api/stripe/payment-intent` and `/api/stripe/confirm`
(`/data/scruple-web/app/api/stripe/payment-intent/route.ts`), and both
call `auth()` -- a browser session cookie -- not a bearer key. D-2 is
explicit that session cookies "are never an alternative" on a plugin
route. A /v2 bearer-key client calling `/api/stripe/payment-intent`
today gets a 401, not a charge.

This module is written against the shape those routes already expose
(matching the existing Blender/Meshroom flow, and the response fields
`/api/lock/*` return) so that if a bearer-compatible payment route ships
under `/v2` later, only the path strings below need to change. As
deployed right now, `charge()` will reliably fail with a 401 the first
time it is exercised against a real server -- there is no way to make
priced modalities work from a headless plugin session against the
current route set, and pretending otherwise here would be exactly the
kind of silent stub this build was commissioned to remove.

Also worth noting: `/api/v2/mark`'s current implementation (see
`app/api/v2/mark/route.ts`) does not check `payment_intent_id` at all --
every non-local modality reports `outstanding` unconditionally,
regardless of payment. So even setting the 401 aside, a successful
charge would not currently unlock anything server-side either.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from . import http as _http

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


@dataclass(frozen=True)
class PaymentResult:
    ok: bool
    payment_intent_id: Optional[str] = None
    requires_action_url: Optional[str] = None
    error: Optional[str] = None


def get_payment_config(session) -> Dict[str, Any]:
    result = _http.submit(session, "GET", "/api/stripe/config")
    return result.body if result.ok and isinstance(result.body, dict) else {}


def has_payment_method(config: Dict[str, Any]) -> bool:
    return payment_method_summary(config) is not None


def payment_method_summary(config: Dict[str, Any]) -> Optional[str]:
    if not isinstance(config, dict):
        return None
    pm = config.get("payment_method") or config.get("paymentMethod")
    if not isinstance(pm, dict):
        return None
    brand = str(pm.get("brand") or pm.get("card_brand") or "card").capitalize()
    last4 = str(pm.get("last4") or "").strip()
    return f"{brand} ending {last4}" if last4 else brand


def price_cents_for(action: str, config: Optional[Dict[str, Any]] = None) -> int:
    if config:
        prices = config.get("prices") if isinstance(config, dict) else None
        if isinstance(prices, dict):
            v = prices.get(action)
            if isinstance(v, (int, float)) and v > 0:
                return int(v)
    return DEFAULT_PRICE_CENTS.get(action, 0)


def format_price(cents: int) -> str:
    return f"${cents / 100:.2f}"


def build_confirm_message(action: str, price_cents: int, pm_summary: Optional[str]) -> str:
    label = ACTION_LABELS.get(action, action)
    price = format_price(price_cents)
    return f"Charge {price} to {pm_summary} for {label}?" if pm_summary else f"Charge {price} for {label}?"


def charge(
    session,
    *,
    project_id: int,
    action: str,
    confirm: Callable[[str], bool],
    config: Optional[Dict[str, Any]] = None,
) -> PaymentResult:
    """Confirm-then-charge. `queue_kind` is deliberately never set on the
    payment-intent request: silently auto-retrying a failed charge
    attempt is a different and worse kind of unsafe than retrying a
    witness POST, so a payment failure is surfaced immediately rather
    than queued -- the caller decides whether to try again."""
    if config is None:
        config = get_payment_config(session)
    if not has_payment_method(config):
        return PaymentResult(ok=False, error="No payment method on file. Set one up on scruple.ai first.")

    price = price_cents_for(action, config)
    pm_summary = payment_method_summary(config)
    if not confirm(build_confirm_message(action, price, pm_summary)):
        return PaymentResult(ok=False, error="Cancelled by user")

    result = _http.submit(session, "POST", "/api/stripe/payment-intent", body={"projectId": project_id, "action": action})
    if not result.ok or not isinstance(result.body, dict):
        return PaymentResult(ok=False, error=result.error or "Empty response from payment-intent")

    body = result.body
    pi = body.get("paymentIntentId") or body.get("payment_intent_id") or body.get("id")
    status = body.get("status") or ""
    if status == "requires_action":
        return PaymentResult(
            ok=False,
            payment_intent_id=pi,
            requires_action_url=body.get("next_action_url") or body.get("hosted_action_url"),
            error="Card needs verification. Finish on scruple.ai/pay/<pi>.",
        )
    if not pi:
        return PaymentResult(ok=False, error=f"No payment_intent id in response: {body!r}")
    if status and status not in {"succeeded", "requires_capture", "processing"}:
        return PaymentResult(ok=False, payment_intent_id=pi, error=f"Unexpected status: {status}")
    return PaymentResult(ok=True, payment_intent_id=pi)
