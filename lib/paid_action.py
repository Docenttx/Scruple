"""Shared spine of every paid operator.

An operator supplies:
  - `action` — the Stripe metadata action key
  - `submit_lock(client, project_id, payment_intent_id)` — the endpoint
    to hit after Stripe returns a pi_.
  - `success_label` for the reporter.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from . import payment as _payment
from . import scruple_client as _client_mod
from . import state as _state
from . import logging as _log


@dataclass
class PaidActionResult:
    ok: bool
    lock_response: Optional[Dict[str, Any]] = None
    payment_intent_id: Optional[str] = None
    error: Optional[str] = None
    cancelled: bool = False


def run_paid_action(
    client: _client_mod.ScrupleClient,
    *,
    action: str,
    project_id: int,
    submit_lock: Callable[[_client_mod.ScrupleClient, int, str], Dict[str, Any]],
    confirm: Callable[[str], bool],
    config: Optional[Dict[str, Any]] = None,
) -> PaidActionResult:
    result = _payment.charge(
        client,
        project_id=project_id,
        action=action,
        confirm=confirm,
        config=config,
    )
    if not result.ok:
        if result.error == "Cancelled by user":
            return PaidActionResult(ok=False, cancelled=True, error=result.error)
        return PaidActionResult(ok=False, error=result.error, payment_intent_id=result.payment_intent_id)
    try:
        lock_resp = submit_lock(client, project_id, result.payment_intent_id)
    except _client_mod.ScrupleClientError as e:
        _log.warn(f"lock submission failed after charge: {e}; pi={result.payment_intent_id}")
        return PaidActionResult(
            ok=False,
            error=f"Lock submission failed after payment: {e}",
            payment_intent_id=result.payment_intent_id,
        )
    _state.get().record_receipt({
        "project_id": project_id,
        "action": action,
        "payment_intent_id": result.payment_intent_id,
        "scr_id": lock_resp.get("scrId"),
        "merkle_root": lock_resp.get("merkleRoot"),
        "status": lock_resp.get("status"),
        "kind": "lock",
    })
    return PaidActionResult(
        ok=True, lock_response=lock_resp, payment_intent_id=result.payment_intent_id,
    )
