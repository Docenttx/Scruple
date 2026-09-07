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
from scruple_api.outcomes import ComponentOutcome, MarkOutcome, Outstanding, WitnessOutcome

from . import capabilities as _capabilities
from . import http as _http
from .errors import NoBaselineError
from .server_library import component_preimage

__all__ = [
    "WitnessOutcome",
    "ComponentOutcome",
    "MarkOutcome",
    "Outstanding",
    "witness",
    "mark",
]


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
    # ---- WO-S1(b): the H-4 §4.3 component envelope ---------------------
    # All optional, all defaulting to the pre-existing behaviour: a caller
    # that passes none of them produces byte-identical requests to the ones
    # this function sent before.
    input_hash: Optional[str] = None,
    model_fingerprints_hash: Optional[str] = None,
    component: Optional[Dict[str, Any]] = None,
    capture: Optional[Dict[str, Any]] = None,
    mac: Optional[str] = None,
    ratchet: Optional[Any] = None,
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

    THE COMPONENT ENVELOPE (WO-S1(b))
    ---------------------------------
    This function accepted `attestation` and `continuity` and stopped. It
    had no `component`/`mac`/`capture` parameter, so no SDK client could
    take part in H-4 per-component sequence accounting -- even though both
    halves already worked end to end against the live route. The addon
    could not work around it either: CANON_SKELETON §5 forbids an adapter
    assembling its own envelope, so the assembly has to be here.

    Two ways to send one, and the second is the one to use:

      component=..., mac=...       the caller MACed it already.
      component=..., ratchet=...   THIS FUNCTION MACs it, over the exact
                                   body it is about to send.

    Prefer `ratchet=`. The MAC is only meaningful if it covers the same
    field set the server reconstructs from the submission, and a caller
    that builds its own preimage from its own dict is one field away from a
    MAC that authenticates the component and says nothing about the event
    (`component_preimage`'s docstring, and the reason that function exists
    at all). Passing the ratchet lets this function call the shared
    preimage function over the finished body, so there is no second field
    list to drift.

    `counter` is the RATCHET'S, not the caller's: when `ratchet` is given,
    whatever counter is in `component` is overwritten with `ratchet.counter`
    before the preimage is built. A counter the component did not actually
    spend is exactly what the ratchet exists to make impossible.

    Sending an envelope with no MAC, or a MAC with no envelope, raises
    ValueError and MAKES NO NETWORK CALL -- the same posture as
    NoBaselineError above. The route refuses both cases with a 400, and
    letting that 400 be the first the caller hears of it turns a
    programming error into a capture failure.

    The MAC is computed BEFORE the request is queued, and the queued replay
    carries it. That is deliberate: §5's ordering is derive, MAC, ratchet,
    THEN enqueue -- the counter is spent when the MAC is computed, not when
    the submission succeeds -- and a retry re-sends identical bytes that the
    server drops idempotently (`deduplicated`). Re-MACing on retry would
    burn a second counter for one event and manufacture the very gap this
    machinery exists to detect.
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
    # Both enter component_preimage(), so a component that computed either
    # one had no way to MAC honestly until they could be sent.
    if input_hash is not None:
        body["input_hash"] = input_hash
    if model_fingerprints_hash is not None:
        body["model_fingerprints_hash"] = model_fingerprints_hash

    # ---- the component envelope, refused client-side when malformed ----
    if component is None and (mac is not None or ratchet is not None):
        raise ValueError(
            "witness() was given a mac/ratchet with no `component` envelope. There is "
            "nothing to verify it against; the route refuses this with a 400 and so "
            "does this function, without sending anything."
        )
    if component is not None:
        if mac is None and ratchet is None:
            raise ValueError(
                "witness() was given a `component` envelope with no `mac` and no "
                "`ratchet`. The counter travels in the clear, so an unMACed envelope "
                "is an unauthenticated claim about a component -- the one thing the "
                "ratchet exists to make impossible. Pass `ratchet=` and let this "
                "function MAC the body it sends, or pass `mac=` if you MACed it "
                "yourself over component_preimage(body)."
            )
        if mac is not None and ratchet is not None:
            raise ValueError(
                "witness() was given BOTH `mac` and `ratchet`. Honouring one would "
                "silently discard the other, and if they disagree the discarded one "
                "is the counter that was actually spent. Pass exactly one."
            )

        # Copied, never mutated in place: the caller's envelope is usually a
        # long-lived dict describing the component, and stamping this event's
        # counter into it would make the next call carry a stale one.
        envelope = dict(component)
        if ratchet is not None:
            # The ratchet owns the counter. Stamped BEFORE the preimage,
            # because the counter is a preimage field -- MACing over one
            # counter and shipping another is a MAC that verifies nothing.
            envelope["counter"] = ratchet.counter
        elif "counter" not in envelope:
            raise ValueError(
                "witness() was given a pre-MACed `component` with no `counter`. The "
                "counter is a preimage field; the server cannot reconstruct the MAC "
                "without it."
            )
        body["component"] = envelope
        if capture is not None:
            body["capture"] = capture

        if ratchet is not None:
            # ONE function builds the preimage and every party calls the same
            # one, over the same submission JSON (§10 C-1, and
            # lib/leaf/componentPreimage.ts's header). `body` at this point is
            # exactly what goes on the wire, so there is no gap between what
            # was MACed and what was sent.
            spent, tag = ratchet.mac(component_preimage(body))
            if spent != envelope["counter"]:
                # Unreachable unless the ratchet advanced underneath us --
                # two threads on one Ratchet, say. Loud rather than silent:
                # the MAC would be over the wrong counter and the server
                # would report it as an unverifiable envelope with no clue why.
                raise RuntimeError(
                    f"ratchet spent counter {spent} but the envelope carries "
                    f"{envelope['counter']}; the MAC would not verify. A Ratchet "
                    "is not safe to share across concurrent witness() calls."
                )
            body["mac"] = tag
        else:
            body["mac"] = mac
    elif capture is not None:
        raise ValueError(
            "witness() was given a `capture` block with no `component`. `capture` is "
            "what the COMPONENT saw; the route only reads it through the component "
            "preimage, so sending it alone would put an unauthenticated observation "
            "on the wire that nothing commits to."
        )

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
        component=_component_outcome(b.get("component")),
        deduplicated=bool(b.get("deduplicated", False)),
    )


def _component_outcome(c: Any) -> Optional[ComponentOutcome]:
    """Read the server's component verdict out by name.

    The route sends `component: null` on every submission that carried no
    envelope -- stated rather than omitted, "because an absent key is a fact
    nobody reads" -- so None here means the same thing on both sides.

    D-8 applies field by field: `verified` and `gap` are read from the body
    and never inferred. In particular `gap` is NOT defaulted from
    `verified` -- a verified envelope with a gap of 3 is the interesting
    case, and the one a defaulting reader would erase.
    """
    if not isinstance(c, dict):
        return None
    return ComponentOutcome(
        component_id=str(c.get("component_id", "")),
        counter=int(c.get("counter", 0)),
        verified=bool(c.get("verified", False)),
        gap=int(c.get("gap", 0)),
        build_changed=bool(c.get("build_changed", False)),
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
