"""Route table for the /api/v2 surface, as the addon exercises it.

One place that knows the shape of a v2 response, so a test that cares
about a single field does not have to restate the other six. Every
response body here is keyed the way `app/api/v2/*/route.ts` keys it --
snake_case, `witnessed` as an explicit boolean, `outstanding` as a list
of {modality, reason} -- because the SDK reads those names out by name
and a mock that used the v1 spellings would let a regression through.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional

BASELINE_REF = "bl_" + "a" * 24


def register_v2(
    opener,
    *,
    baseline_exists: bool = False,
    witnessed: bool = True,
    modalities_available: Optional[List[str]] = None,
    modalities_applied: Optional[List[str]] = None,
    outstanding: Optional[List[Dict[str, str]]] = None,
) -> None:
    """Register the routes a witness+mark round trip needs.

    `baseline_exists=False` makes GET /baseline/current 404, which is
    what drives attach() down its POST /baseline branch.
    """
    if baseline_exists:
        opener.register("GET", "/api/v2/baseline/current", {"baseline_ref": BASELINE_REF})
    opener.register("POST", "/api/v2/baseline", {"baseline_ref": BASELINE_REF})
    opener.register("POST", "/api/v2/baseline/rebaseline", {"baseline_ref": BASELINE_REF})

    def _witness(body: Dict[str, Any]) -> Dict[str, Any]:
        leaf_id = "leaf_" + hashlib.sha256(
            (body.get("content_hash", "") + body.get("kind", "")).encode()
        ).hexdigest()[:16]
        return {
            "leaf_id": leaf_id,
            "leaf_hash": hashlib.sha256(leaf_id.encode()).hexdigest(),
            "witnessed": witnessed,
            "leaf_scheme": "v2",
            "baseline_ref": body.get("baseline_ref"),
            "canonicalization_profile": "jcs-2",
        }

    opener.register("POST", "/api/v2/witness", _witness)

    caps = modalities_available if modalities_available is not None else ["c2pa", "watermark", "chain", "local"]
    opener.register(
        "GET",
        "/api/v2/capabilities",
        {"modalities": [
            {"modality": m, "available": True, "reason": "", "price_cents": 5000}
            for m in caps
        ]},
    )

    def _mark(body: Dict[str, Any]) -> Dict[str, Any]:
        requested = list(body.get("modalities") or [])
        applied = modalities_applied if modalities_applied is not None else requested
        out = outstanding if outstanding is not None else [
            {"modality": m, "reason": "not performed"} for m in requested if m not in applied
        ]
        return {
            "leaf_id": body.get("leaf_id"),
            "modalities_requested": requested,
            "modalities_applied": applied,
            "outstanding": out,
            "local_lock": {"scr_id": "SCR_local", "merkle_root": "a" * 64},
            "witnessed": True,
        }

    opener.register("POST", "/api/v2/mark", _mark)


def register_stripe(opener, *, payment_intent_id: str = "pi_ok", status: str = "succeeded") -> None:
    """The v1 stripe routes the SDK's payment.py still points at. They are
    v1 on purpose: /v2 exposes no route that creates a PaymentIntent, and
    the ones that exist authenticate with a session cookie, not a bearer
    key. See scruple_host_sdk/payment.py's header."""
    opener.register("GET", "/api/stripe/config", {
        "payment_method": {"brand": "Visa", "last4": "4242"},
        "prices": {
            "checkpoint": 500, "finalize": 1000,
            "chain-lock-basic": 5000, "chain-lock-pinned": 10000,
        },
    })
    opener.register("POST", "/api/stripe/payment-intent", {
        "paymentIntentId": payment_intent_id, "status": status,
    })
