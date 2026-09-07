"""Compose capture + the client into witness and mark actions.

Kept as one module, as it was in every fork, because both an ambient
host hook (`document.save`, `artifact.produced`) and a manual
"witness now" action dispatch through the same two functions -- they
only differ in the trigger label the adapter attaches, which is the
adapter's concern, not this module's.

D-8 (witnessed is always explicit, never inferred from HTTP status) and
D-4/§9.5 (modality selection is recorded, `outstanding` is honest) are
both enforced here: every field the server sent is read out by name,
nothing is inferred from `result.ok` or the HTTP status code alone.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Shared with the no-op recorder so `outcome.witnessed` means the same
# thing and reads the same fields whichever side answered. See
# scruple_api/outcomes.py.
from scruple_api.outcomes import MarkOutcome, Outstanding, WitnessOutcome

from . import capabilities as _capabilities
from . import http as _http
from .errors import NoBaselineError

__all__ = ["WitnessOutcome", "MarkOutcome", "Outstanding", "witness", "mark"]


def witness(
    session,
    *,
    kind: str,
    content_hash: str,
    mime: str,
    project_id: Optional[int] = None,
    graph: Optional[Dict[str, Any]] = None,
    training: Optional[Dict[str, Any]] = None,
    machine_manifest_hash: Optional[str] = None,
    attestation: Optional[Dict[str, Any]] = None,
    continuity: Optional[Dict[str, Any]] = None,
) -> WitnessOutcome:
    """POST /v2/witness for one event.

    Raises NoBaselineError, making NO network call, if this session has
    no established baseline (`session.state.baseline_ref`). D-3: a leaf
    without a baseline_ref is not a weaker leaf, it is not
    Scruple-witnessed at all (§3, §5) -- refused client-side rather than
    letting a server 409 be the first the caller hears of it.

    A network or server failure enqueues this call for retry
    (queue_kind="witness") and returns witnessed=False, queued=True --
    distinguish this from witnessed=False on a call that DID reach the
    server (capture is non-blocking there too; see leaf_scheme=="v1").
    """
    if not session.state.baseline_ref:
        raise NoBaselineError(
            "No baseline established for this session. Call Client.attach() "
            "first -- witnessing without a baseline is refused client-side "
            "(D-3), not merely discouraged."
        )
    if not mime or not mime.strip():
        raise ValueError("witness() requires an explicit `mime` -- see capture.capture()'s docstring.")

    body: Dict[str, Any] = {
        "baseline_ref": session.state.baseline_ref,
        "kind": kind,
        "content_hash": content_hash,
        "mime": mime,
    }
    if project_id is not None:
        body["project_id"] = project_id
    if graph is not None:
        body["graph"] = graph
    if training is not None:
        body["training"] = training
    if machine_manifest_hash is not None:
        body["machine_manifest_hash"] = machine_manifest_hash
    if attestation is not None:
        body["attestation"] = attestation
    if continuity is not None:
        body["continuity"] = continuity

    result = _http.submit(session, "POST", "/api/v2/witness", body=body, queue_kind="witness", queue_replay=body)

    if result.queued or not result.ok:
        return WitnessOutcome(
            leaf_id=None,
            leaf_hash=None,
            witnessed=False,
            leaf_scheme=None,
            baseline_ref=session.state.baseline_ref,
            queued=result.queued,
            error=result.error,
        )

    b = result.body or {}
    return WitnessOutcome(
        leaf_id=b.get("leaf_id"),
        leaf_hash=b.get("leaf_hash"),
        witnessed=bool(b.get("witnessed", False)),
        leaf_scheme=b.get("leaf_scheme"),
        baseline_ref=b.get("baseline_ref"),
        queued=False,
    )


def mark(
    session,
    *,
    leaf_id: str,
    host: str,
    mime: str,
    modalities: Optional[List[str]] = None,
    chain_tier: Optional[str] = None,
    payment_intent_id: Optional[str] = None,
) -> MarkOutcome:
    """POST /v2/mark. `modalities` defaults to [] -- an empty selection is
    valid and means local-lock only; a local lock is always performed
    server-side regardless of what is requested (D-5, §9.4).

    Property 2, enforced a second time here (capture() enforces property
    1; this enforces property 2 -- defense in depth, not redundancy: an
    adapter could call mark() without ever calling capture()). Every
    requested modality is checked against GET /capabilities BEFORE this
    function sends anything. An unknown or unavailable modality raises
    ModalityUnavailableError and the /mark request for it is never sent
    -- there is no downgrade to a substitute modality.
    """
    requested = list(dict.fromkeys(modalities or []))
    for m in requested:
        _capabilities.require_available(session, host=host, mime=mime, modality=m)

    body: Dict[str, Any] = {"leaf_id": leaf_id, "host": host, "modalities": requested}
    if chain_tier is not None:
        body["chain_tier"] = chain_tier
    if payment_intent_id is not None:
        body["payment_intent_id"] = payment_intent_id

    result = _http.submit(session, "POST", "/api/v2/mark", body=body, queue_kind="mark", queue_replay=body)

    if result.queued or not result.ok:
        return MarkOutcome(
            leaf_id=leaf_id,
            modalities_requested=requested,
            modalities_applied=[],
            outstanding=[Outstanding(modality=m, reason=result.error or "request not delivered") for m in requested],
            local_lock={},
            witnessed=False,
            queued=result.queued,
            error=result.error,
        )

    b = result.body or {}
    outstanding = [Outstanding(modality=o.get("modality", ""), reason=o.get("reason", "")) for o in b.get("outstanding", [])]
    return MarkOutcome(
        leaf_id=b.get("leaf_id", leaf_id),
        modalities_requested=b.get("modalities_requested", requested),
        modalities_applied=b.get("modalities_applied", []),
        outstanding=outstanding,
        local_lock=b.get("local_lock", {}),
        witnessed=bool(b.get("witnessed", False)),
        queued=False,
    )
