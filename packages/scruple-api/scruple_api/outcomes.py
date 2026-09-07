"""The result types every witness call returns, whichever side of the
API/SDK line answered it.

These are in `scruple-api` for one blunt reason: a vendor's call site
writes `if outcome.witnessed:` exactly once, and that line must mean the
same thing and read the same fields whether a real SDK produced the
outcome or the no-op did. Two structurally-similar dataclasses defined in
two packages would be an `isinstance` trap and, worse, an invitation for
the no-op's version to drift into something more flattering.

D-8 is why `witnessed` is a field at all: witnessed is always explicit,
never inferred from an HTTP status. The no-op honours D-8 by the only
route available to it -- `witnessed=False`, always, with a `reason` that
says why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class AttachResult:
    baseline_ref: Optional[str]
    established: bool  # True: this call created the baseline. False: it verified an existing one.
    drifted: bool  # True: the server's active baseline differs from what attach() just computed.
    server_baseline_ref: Optional[str] = None


@dataclass(frozen=True)
class ComponentOutcome:
    """What the server said about the H-4 §4.3 envelope this event carried.

    WO-S1(b). `witness()` could not send a component envelope at all, so
    an SDK client could not participate in per-component sequence
    accounting even though both halves of it already worked. This is the
    half the caller reads back.

    `gap` IS THE PRODUCT. It is the count of counters this component spent
    and never delivered, and it is what makes suppression visible: an
    event that was captured and then dropped leaves a hole in the counter
    sequence that the next delivered event reports. 0 is the ordinary
    case. Anything else says events happened that are not in the record,
    and per §4.2 it does NOT invalidate this leaf -- a suppressed event
    must not be able to attack the vendor's whole chain.

    `verified` is read from the body and never inferred from the status:
    the route accepts a submission with no component at all, and a 201 is
    therefore not evidence that anything was checked (D-8, again).
    """

    component_id: str
    counter: int
    verified: bool
    gap: int = 0
    build_changed: bool = False


@dataclass(frozen=True)
class WitnessOutcome:
    leaf_id: Optional[str]
    leaf_hash: Optional[str]
    witnessed: bool  # D-8: first-class boolean, read from the response body, never from status.
    leaf_scheme: Optional[str]
    baseline_ref: Optional[str]
    queued: bool
    error: Optional[str] = None
    # WO-S1(b). Appended with defaults so every existing construction --
    # including scruple_api/provider.py's no-op -- keeps working unchanged.
    #
    # None means NO COMPONENT ENVELOPE WAS SENT, which is the ordinary case
    # for canvas and the plugins. It does not mean the envelope failed: a
    # rejected envelope is an error response, not a null here.
    component: Optional["ComponentOutcome"] = None
    # The server already held this (component_id, counter). A queue retry
    # re-sends the same bytes by design, and the route drops the duplicate
    # idempotently rather than writing a second leaf for one event -- so
    # this is a SUCCESS, and reading it as `witnessed=False` alone would
    # lose the difference between "already recorded" and "not recorded".
    deduplicated: bool = False


@dataclass(frozen=True)
class Outstanding:
    modality: str
    reason: str


@dataclass(frozen=True)
class MarkOutcome:
    leaf_id: Optional[str]
    modalities_requested: List[str]
    modalities_applied: List[str]
    outstanding: List[Outstanding] = field(default_factory=list)
    local_lock: Dict[str, Any] = field(default_factory=dict)
    witnessed: bool = False
    queued: bool = False
    error: Optional[str] = None
