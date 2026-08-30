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
class WitnessOutcome:
    leaf_id: Optional[str]
    leaf_hash: Optional[str]
    witnessed: bool  # D-8: first-class boolean, read from the response body, never from status.
    leaf_scheme: Optional[str]
    baseline_ref: Optional[str]
    queued: bool
    error: Optional[str] = None


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
