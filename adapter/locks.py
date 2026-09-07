"""What a paid action would cost, whether it can be asked for, and what
has already been applied to a leaf.

WO-B5. The panel had four paid buttons with a price glued to the label
and nothing else. Press one and the result went into Blender's info bar,
which the next report overwrites -- so the panel could not answer the
question a lock dashboard exists to answer: *what is the state of this
thing right now*.

Two halves here.

THE CONTROLS. `actions()` builds one `LockAction` per priced modality,
carrying its price, whether it can be asked for at all, and if not, why
not. Three reasons a control can be unavailable and they are not the
same:

  * no payment method on file -- fixable by the user, on scruple.ai;
  * nothing to mark -- /api/v2/mark marks a LEAF, so there must have
    been a witness first (operators/c2pa.py:NO_LEAF_REASON);
  * no route -- checkpoint has no /api/v2 equivalent at all
    (operators/checkpoint.py). This one is not fixable by anybody in
    Blender and the panel says so rather than drawing a button that
    explains itself only after it is pressed.

An unavailable control draws NO operator. A greyed-out button that
still exists is how a user learns to press it and read the error; a
sentence where the button would be is the honest version, and it makes
the absence testable.

THE STATE. `record()` keeps the `MarkOutcome` for each leaf this session
marked, and `state_line()` renders it. It renders `outstanding` -- what
was paid for and NOT done -- with the same weight as what was applied,
because §9.5's whole point is that `outstanding` is the honest half of
the response and a dashboard that showed only `modalities_applied`
would turn a partial failure into a success.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from scruple_host_sdk import payment as _payment


# ---- why a control cannot be used ---------------------------------------

AVAILABLE = "available"
NO_PAYMENT_METHOD = "no_payment_method"
NO_LEAF = "no_leaf"
NO_ROUTE = "no_route"
NOT_SIGNED_IN = "not_signed_in"

_REASON_SENTENCE = {
    NO_PAYMENT_METHOD: "No payment method on file. Add one on scruple.ai.",
    NO_LEAF: "Nothing to mark yet — witness a render or a save first.",
    NO_ROUTE: (
        "No /api/v2 route for this. v1's project-level checkpoint has no "
        "member in v2's modality set (c2pa, watermark, chain, local)."
    ),
    NOT_SIGNED_IN: "Not signed in.",
}


def reason_sentence(reason: str) -> str:
    return _REASON_SENTENCE.get(reason, "")


@dataclass(frozen=True)
class LockAction:
    """One priced control, with everything the panel needs to draw it and
    nothing it would have to guess."""

    action: str
    label: str
    operator: Optional[str]
    price_cents: int
    reason: str = AVAILABLE
    #: The `tier` property to set on the operator, for the two chain rows.
    tier: Optional[str] = None
    #: What this modality does, in one clause. Standard section in brackets
    #: because the four buttons are four different things and "Lock" is not
    #: a description of any of them.
    note: str = ""

    @property
    def available(self) -> bool:
        return self.reason == AVAILABLE

    @property
    def price(self) -> str:
        return _payment.format_price(self.price_cents)

    @property
    def button_text(self) -> str:
        return f"{self.label}  {self.price}"

    @property
    def blocked_sentence(self) -> str:
        return reason_sentence(self.reason)


def actions(
    *,
    signed_in: bool,
    payment_ready: bool,
    has_leaf: bool,
    config: Optional[Dict[str, Any]] = None,
) -> List[LockAction]:
    """The four priced controls, in the order a user meets them.

    Prices come from `/api/stripe/config` when it has been fetched and
    from the SDK's defaults when it has not -- `price_cents_for` already
    makes that choice, and it is the same one the confirm dialog makes,
    so the label and the dialog cannot disagree.
    """

    def _reason(no_route: bool = False) -> str:
        if no_route:
            return NO_ROUTE
        if not signed_in:
            return NOT_SIGNED_IN
        if not payment_ready:
            return NO_PAYMENT_METHOD
        if not has_leaf:
            return NO_LEAF
        return AVAILABLE

    return [
        LockAction(
            action=_payment.ACTION_C2PA,
            label="Local Lock",
            operator="scruple.c2pa_sign",
            price_cents=_payment.price_cents_for(_payment.ACTION_C2PA, config),
            reason=_reason(),
            note="Finalize + user receipt (§9.4). Attaches no C2PA credential.",
        ),
        LockAction(
            action=_payment.ACTION_CHAIN_BASIC,
            label="Chain-lock (basic)",
            operator="scruple.chain_lock",
            price_cents=_payment.price_cents_for(_payment.ACTION_CHAIN_BASIC, config),
            reason=_reason(),
            tier="basic",
            note="Public RVN anchor.",
        ),
        LockAction(
            action=_payment.ACTION_CHAIN_PINNED,
            label="Chain-lock (pinned)",
            operator="scruple.chain_lock",
            price_cents=_payment.price_cents_for(_payment.ACTION_CHAIN_PINNED, config),
            reason=_reason(),
            tier="pinned",
            note="RVN anchor + IPFS + Arweave.",
        ),
        LockAction(
            action=_payment.ACTION_CHECKPOINT,
            label="Checkpoint",
            operator=None,
            price_cents=_payment.price_cents_for(_payment.ACTION_CHECKPOINT, config),
            reason=_reason(no_route=True),
            note="Unavailable under v2.",
        ),
    ]


# ---- what has been applied ----------------------------------------------

@dataclass(frozen=True)
class MarkRecord:
    """One `POST /api/v2/mark`, as it came back."""

    leaf_id: str
    requested: Tuple[str, ...] = ()
    applied: Tuple[str, ...] = ()
    #: (modality, reason) pairs -- paid for and not performed.
    outstanding: Tuple[Tuple[str, str], ...] = ()
    scr_id: Optional[str] = None
    queued: bool = False
    error: Optional[str] = None
    at: float = field(default_factory=time.time)

    @property
    def clean(self) -> bool:
        """Everything asked for was done, and it was done now rather than
        spooled. Deliberately false for a queued mark: nothing is on the
        record until the queue drains."""
        return not self.error and not self.queued and not self.outstanding


def from_outcome(outcome) -> MarkRecord:
    local = getattr(outcome, "local_lock", None) or {}
    return MarkRecord(
        leaf_id=str(getattr(outcome, "leaf_id", "") or ""),
        requested=tuple(getattr(outcome, "modalities_requested", ()) or ()),
        applied=tuple(getattr(outcome, "modalities_applied", ()) or ()),
        outstanding=tuple(
            (str(o.modality), str(o.reason)) for o in (getattr(outcome, "outstanding", ()) or ())
        ),
        scr_id=local.get("scr_id") if isinstance(local, dict) else None,
        queued=bool(getattr(outcome, "queued", False)),
        error=getattr(outcome, "error", None),
    )


NOT_MARKED = "Not locked. Witnessed only — no paid modality has been applied."


def state_line(record: Optional[MarkRecord]) -> str:
    """The lock state of one leaf, in one line.

    `None` is "no mark was attempted", which is a different sentence from
    "a mark was attempted and applied nothing" -- the second means money
    changed hands.
    """
    if record is None:
        return NOT_MARKED
    if record.error:
        return f"Lock FAILED: {record.error}"
    if record.queued:
        return "Lock queued — the server was unreachable. Nothing is on the record yet."
    applied = ", ".join(record.applied) or "local lock only"
    line = f"Applied: {applied}"
    if record.scr_id:
        line += f" · {record.scr_id}"
    if record.outstanding:
        gaps = "; ".join(f"{m}: {r}" for m, r in record.outstanding)
        line += f" · OUTSTANDING — {gaps}"
    return line
