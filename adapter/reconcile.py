"""Settlement: drain what is spooled, then find out what is missing.

`L2_AS_THE_VENDOR_FLOOR.md`, Missing 2:

    "Banking's answer is settlement: terminals run offline under floor
    limits, and end-of-day reconciliation catches the one that diverged
    or went silent. We have the first half -- queue.py is a crash-durable
    JSONL queue with backoff -- and none of the second."

This is the second half, as far as a client can honestly build it.

THE ONE RULE THIS MODULE IS WRITTEN AROUND: a reconciliation may never
report "all clear" because it could not find out. Three answers, not two
--- present, absent, and NOT ASKED --- and the third is a failure of the
settlement, not a pass. `Reconciliation.all_clear` is False whenever
anything is `unchecked`, and `test_reconcile.py` breaks that on purpose to
prove the flag moves.

HOW A MISSING LEAF IS DETECTED, mechanically:

  1. The ledger (`adapter/ledger.py`) holds one line per capture, written
     BEFORE the request. It is what this client believes it produced.
  2. `Client.detach()` -- the SDK's drain, not a retry written here --
     replays everything spooled and removes what lands.
  3. Every ledger line is then checked against the SERVER, one
     `GET /api/v2/verify/{content_hash}` each. That route answers
     `found: true|false` for a content hash and is public, so this is a
     third-party check rather than the addon grading its own homework.
  4. A line whose hash the server does not have, and which is no longer in
     the queue, is a GAP: the capture happened, nothing is left to retry,
     and it is not on the record.

Step 3 is why a queue entry that is deleted, corrupted or lost is caught.
The queue no longer knows about it; the ledger still does; the server says
`found: false`; the difference is the gap. A reconciliation that only
inspected the queue would report a clean queue, which is what "silently
absent" looks like.

WHAT THIS CANNOT SEE, and the server surface that can. A capture that
never reached the ledger at all leaves nothing to diff. That is the H-4
component ratchet's job: a monotonic per-component counter, MACed, so the
SERVER notices counter n+1 arriving when n never did.
`GET /api/v2/components/status` already implements it -- gaps, open and
resolved, plus a heartbeat window and a silence state -- and
`component_status()` below reads it. It reports `not_configured` today,
because the addon cannot put a component envelope on the wire: the SDK's
`witness_flow.witness()` has no `component` / `mac` parameter to pass one
through, and an adapter may not assemble its own request (CANON_SKELETON
§5). Measured, not assumed --- see
`docs/canon/blender-l2/04-STORE-AND-FORWARD.md`, which shows the same
witness route accepting a MACed envelope from this addon's own vendored
`Ratchet` and reporting the gap, over curl.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from . import assurance as _assurance
from . import ledger as _ledger
from . import log as _log
from . import state as _state


# ---- what a ledger line settles to -------------------------------------

SETTLED = "settled"
OUTSTANDING = "outstanding"
GAP = "gap"
REFUSED_LOCALLY = "refused_locally"
REJECTED = "rejected"
UNCHECKED = "unchecked"
UNIDENTIFIABLE = "unidentifiable"

#: The dispositions that mean something is missing from the record and
#: nothing is going to fix it on its own.
FAILING = (GAP,)

#: The dispositions that mean the settlement did not establish an answer.
#: Not failures of the record -- failures of the SETTLEMENT, which must
#: never round down to "clear".
INCONCLUSIVE = (UNCHECKED, UNIDENTIFIABLE)

#: Known, expected, and not finished. Not a failure and not clear either:
#: a capture still in the queue is not on the record yet, so a settlement
#: that called it clear would be reporting on a future.
PENDING = (OUTSTANDING,)

#: Everything is settled or accounted for with a reason.
ACCOUNTED_FOR = (SETTLED, REFUSED_LOCALLY, REJECTED)

_SENTENCE = {
    SETTLED: "On Scruple's record. The server was asked and answered yes.",
    OUTSTANDING: "Not delivered yet. Still spooled on disk and still being retried.",
    GAP: (
        "MISSING. This capture happened, it is not on Scruple's record, and "
        "nothing is left in the queue to deliver it."
    ),
    REFUSED_LOCALLY: "Never sent. Refused here, with a reason, before anything left the machine.",
    REJECTED: "Refused by the server. Not retried, and it will not arrive on its own.",
    UNCHECKED: "NOT ESTABLISHED. The server could not be asked, so this is neither present nor absent.",
    UNIDENTIFIABLE: (
        "NOT ESTABLISHED. This capture has no content hash recorded, so there is "
        "nothing to ask the server about."
    ),
}


def sentence_for(disposition: str) -> str:
    return _SENTENCE.get(disposition, f"Unknown disposition {disposition!r}.")


@dataclass
class LineResult:
    entry_id: str
    seq: int
    disposition: str
    content_hash: Optional[str]
    filename: Optional[str]
    kind: Optional[str]
    ledger_state: str
    leaf_id: Optional[str] = None
    error: Optional[str] = None

    @property
    def sentence(self) -> str:
        return sentence_for(self.disposition)


@dataclass
class DrainResult:
    """What `Client.detach()` did, plus what the queue looked like on
    either side of it. The before/after ids are recorded because the
    SDK's drain returns counts only, and "which entries left" is the
    question settlement actually asks."""

    attempted: int = 0
    succeeded: int = 0
    failed: int = 0
    remaining: int = 0
    ids_before: List[str] = field(default_factory=list)
    ids_after: List[str] = field(default_factory=list)
    #: In the queue before the drain and gone afterwards. A drained entry
    #: is only BELIEVED delivered here; whether it landed is settled by
    #: asking the server, not by this list.
    ids_left: List[str] = field(default_factory=list)


@dataclass
class Reconciliation:
    started_at: float
    finished_at: float
    drain: DrainResult
    lines: List[LineResult] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)
    #: Non-empty ledger lines that did not parse.
    damaged_ledger_lines: int = 0
    #: Sequence numbers with no line at all -- a ledger that lost a row.
    missing_ledger_seq: List[int] = field(default_factory=list)
    #: What GET /api/v2/components/status said, or why it was not asked.
    component: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    @property
    def gaps(self) -> List[LineResult]:
        return [l for l in self.lines if l.disposition in FAILING]

    @property
    def inconclusive(self) -> List[LineResult]:
        return [l for l in self.lines if l.disposition in INCONCLUSIVE]

    @property
    def pending(self) -> List[LineResult]:
        return [l for l in self.lines if l.disposition in PENDING]

    @property
    def all_clear(self) -> bool:
        """True only when every capture is accounted for AND every question
        got an answer.

        A settlement that could not reach the server is not clear, a ledger
        that lost a line is not clear, a capture with no hash to ask about
        is not clear, and neither is one still sitting in the queue. Each
        of those is a state in which this client does not know that a
        capture is on the record, and "do not know" must not render as
        "fine" -- that is the exact failure `L2_AS_THE_VENDOR_FLOOR.md`
        Missing 2 describes.
        """
        if self.gaps or self.inconclusive or self.pending:
            return False
        if self.damaged_ledger_lines or self.missing_ledger_seq:
            return False
        return True

    @property
    def summary(self) -> str:
        if self.error:
            return f"Reconciliation could not run: {self.error}"
        if self.all_clear:
            n = self.counts.get(SETTLED, 0)
            return f"Settled: {n} capture(s) confirmed on Scruple's record, nothing missing."
        bits = []
        if self.gaps:
            bits.append(f"{len(self.gaps)} MISSING")
        if self.counts.get(OUTSTANDING):
            bits.append(f"{self.counts[OUTSTANDING]} still queued")
        if self.counts.get(UNCHECKED):
            bits.append(f"{self.counts[UNCHECKED]} unchecked")
        if self.counts.get(UNIDENTIFIABLE):
            bits.append(f"{self.counts[UNIDENTIFIABLE]} with no hash to check")
        if self.counts.get(REJECTED):
            bits.append(f"{self.counts[REJECTED]} refused by the server")
        if self.damaged_ledger_lines:
            bits.append(f"{self.damaged_ledger_lines} damaged ledger line(s)")
        if self.missing_ledger_seq:
            bits.append(f"ledger rows {self.missing_ledger_seq} absent")
        return "; ".join(bits) or "Nothing to settle."

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["all_clear"] = self.all_clear
        d["summary"] = self.summary
        for line, src in zip(d["lines"], self.lines):
            line["sentence"] = src.sentence
        return d


# ---- the drain ----------------------------------------------------------


def drain(client) -> DrainResult:
    """Replay everything spooled, through the SDK's own drain.

    `Client.detach()` and nothing else. An adapter may not write its own
    retry (CANON_SKELETON §5), and the SDK's drain already gets the two
    things that are easy to get wrong right: it passes `queue_kind=None`
    so a failing entry is not enqueued a SECOND time, and backoff state
    lives in the entry rather than in a caller's loop.

    What is added here is the before/after snapshot of the queue, because
    `detach()` returns counts and settlement needs identities.
    """
    before = [str(e.get("id")) for e in client.queue.load_all()]
    result = client.detach()
    after = [str(e.get("id")) for e in client.queue.load_all()]
    left = [i for i in before if i not in set(after)]
    if before:
        _log.info(
            f"drain: {len(before)} spooled -> {result.get('succeeded', 0)} delivered, "
            f"{result.get('remaining', 0)} remaining"
        )
    return DrainResult(
        attempted=len(before),
        succeeded=int(result.get("succeeded", 0)),
        failed=int(result.get("failed", 0)),
        remaining=int(result.get("remaining", 0)),
        ids_before=before,
        ids_after=after,
        ids_left=left,
    )


# ---- the settlement -----------------------------------------------------


def _queued_content_hashes(client) -> Dict[str, str]:
    """content_hash -> queue entry id, for everything still spooled.

    Read off the queue's stored bodies. A witness entry's body is the
    submission, so its `content_hash` is the same string the ledger holds
    -- which is what lets a ledger line and a queue entry be recognised as
    the same capture without either of them holding the other's id.
    """
    out: Dict[str, str] = {}
    for e in client.queue.load_all():
        body = e.get("body") or {}
        ch = body.get("content_hash")
        if isinstance(ch, str) and ch:
            out[ch] = str(e.get("id"))
    return out


def _ask_server(client, content_hash: str):
    """`GET /api/v2/verify/{content_hash}`.

    Returns `(found, leaf_id, asked_ok)`. `asked_ok=False` means the
    question was not answered -- a transport failure, a 5xx, a refusal --
    and the caller must NOT read that as `found=False`. This is the whole
    reason for the third return value: `verify()` raising and `verify()`
    answering "no" are opposite facts and they arrive on the same code
    path.

    A verify is a query, not an operation: `http.submit` gives it
    `queue_kind=None`, so a failure here is never spooled.
    """
    try:
        body = client.verify(content_hash)
    except Exception as e:
        _log.warn(f"reconcile: verify({content_hash[:16]}) failed: {e}")
        return None, None, False
    if not isinstance(body, dict):
        return None, None, False
    found = bool(body.get("found"))
    leaf = body.get("leaf") if isinstance(body.get("leaf"), dict) else {}
    return found, (leaf.get("leaf_id") if found else None), True


def component_status(client, component_id: Optional[str] = None) -> Dict[str, Any]:
    """What the SERVER's own reconciliation view would say -- and why this
    addon cannot read it.

    `GET /api/v2/components/status` is the settlement surface H-4 §4.2
    specifies and `lib/reconcile/status.ts` implements: per-component
    counter accounting, gaps open and resolved, a heartbeat window and a
    silence state. It is the half of Missing 2 a CLIENT ledger cannot do,
    because it notices a counter that was never delivered even when the
    client that spent it never came back to say so.

    It always answers `available: False` here, with one of two reasons, and
    both are facts about the API rather than about this addon's diligence:

      `not_configured`  -- the addon holds no component identity, because it
                           cannot send a component envelope (see below), so
                           there is no id to ask about.
      `no_sdk_route`    -- an id was supplied and there is still no way to
                           ask: `scruple_host_sdk.Client` exposes `receipt()`
                           and `verify()` and no `component_status()`, and
                           CANON_SKELETON §5 forbids an adapter constructing
                           the request itself. The change belongs in
                           `packages/scruple-host-sdk` (docs/developer.md,
                           "Adding a scruple-web endpoint"), which this work
                           order may not edit.

    A dict with `available` always present, rather than an empty one: "not
    asked" and "asked and told nothing" are different, and a caller
    rendering one must not print the other.
    """
    if not component_id:
        return {
            "available": False,
            "reason": "not_configured",
            "detail": (
                "This addon sends no H-4 component envelope, so the server holds no "
                "counter sequence for it and its gap detection cannot apply. "
                "docs/canon/blender-l2/04-STORE-AND-FORWARD.md shows the same witness "
                "route accepting a MACed envelope built from this addon's own vendored "
                "Ratchet, and reporting the gap -- what is missing is a parameter on "
                "scruple_host_sdk.witness_flow.witness(), not a mechanism."
            ),
        }
    return {
        "available": False,
        "reason": "no_sdk_route",
        "component_id": component_id,
        "detail": (
            "scruple_host_sdk.Client exposes no components/status call and an adapter "
            "may not construct one (CANON_SKELETON §5). The addition belongs in "
            "packages/scruple-host-sdk."
        ),
    }


def reconcile(client, *, drain_first: bool = True, component_id: Optional[str] = None) -> Reconciliation:
    """Settle this client's ledger against the server.

    `drain_first=False` exists for the case where the caller has already
    drained (a timer tick that just ran one) and for tests that want the
    settlement measured against a queue in a known state. It never
    changes what counts as a gap.
    """
    started = time.time()
    led = _ledger.get(client)
    if led is None:
        return Reconciliation(
            started_at=started,
            finished_at=time.time(),
            drain=DrainResult(),
            error="No session ledger -- nothing has been captured in this profile.",
        )

    dr = drain(client) if drain_first else DrainResult(
        remaining=client.queue_depth,
        ids_after=[str(e.get("id")) for e in client.queue.load_all()],
    )

    still_queued = _queued_content_hashes(client)
    lines: List[LineResult] = []

    for entry in led.load_all():
        state = str(entry.get("state") or "")
        ch = entry.get("content_hash")
        result = LineResult(
            entry_id=str(entry.get("id")),
            seq=int(entry.get("seq") or 0),
            disposition=UNCHECKED,
            content_hash=ch if isinstance(ch, str) else None,
            filename=entry.get("filename"),
            kind=entry.get("kind"),
            ledger_state=state,
            leaf_id=entry.get("leaf_id"),
            error=entry.get("error"),
        )

        # A capture refused here never reached the wire and its reason is
        # on the line. It is accounted for, so it is not a gap -- but it is
        # reported, because a session that refused four captures must not
        # read as a session that took none (vendor floor item 5).
        if state == _ledger.REFUSED_LOCALLY:
            result.disposition = REFUSED_LOCALLY
            lines.append(result)
            continue

        if not result.content_hash:
            # An intent recorded before the hash existed, or a process that
            # died between the two. Nothing to ask about.
            result.disposition = UNIDENTIFIABLE
            lines.append(result)
            continue

        # Still spooled: this one has not failed, it has not finished.
        if result.content_hash in still_queued:
            result.disposition = OUTSTANDING
            led.update(result.entry_id, state=_ledger.QUEUED, queue_id=still_queued[result.content_hash])
            lines.append(result)
            continue

        found, leaf_id, asked = _ask_server(client, result.content_hash)
        if not asked:
            result.disposition = UNCHECKED
            lines.append(result)
            continue

        if found:
            result.disposition = SETTLED
            result.leaf_id = leaf_id or entry.get("leaf_id")
            led.update(
                result.entry_id,
                state=_ledger.SETTLED,
                leaf_id=result.leaf_id,
                queue_id=None,
                checked_at=time.time(),
                server_found=True,
            )
            lines.append(result)
            continue

        # Not on the record, and nothing left to deliver it. A server that
        # refused it (4xx) is a KNOWN loss with a reason; anything else is
        # a gap -- including a capture this client believed was witnessed.
        result.disposition = REJECTED if state == _ledger.REJECTED else GAP
        led.update(
            result.entry_id,
            state=_ledger.GAP if result.disposition == GAP else state,
            checked_at=time.time(),
            server_found=False,
        )
        lines.append(result)

    counts: Dict[str, int] = {}
    for l in lines:
        counts[l.disposition] = counts.get(l.disposition, 0) + 1

    rec = Reconciliation(
        started_at=started,
        finished_at=time.time(),
        drain=dr,
        lines=lines,
        counts=counts,
        damaged_ledger_lines=led.damaged_lines(),
        missing_ledger_seq=led.missing_seq(),
        component=component_status(client, component_id),
    )
    _log.info(f"reconcile: {rec.summary}")
    _state.record_reconciliation(rec)
    _sync_tracker(rec)
    return rec


def _sync_tracker(rec: Reconciliation) -> None:
    """Fold settlement back into the per-session tracker.

    A capture that was `queued` when the panel last drew it and has since
    landed must stop reading as queued; a capture the server does not have
    must stop reading as witnessed. Both directions matter: the second is
    the one that keeps a tracker from being more flattering than the
    record.
    """
    from dataclasses import replace

    for line in rec.lines:
        if not line.content_hash:
            continue
        for existing in _state.assurances():
            if getattr(existing, "content_hash", None) != line.content_hash:
                continue
            if line.disposition == SETTLED and existing.state != _assurance.WITNESSED:
                _state.replace_assurance(
                    existing,
                    replace(existing, state=_assurance.WITNESSED, leaf_id=line.leaf_id or existing.leaf_id),
                )
            elif line.disposition == GAP and existing.state == _assurance.WITNESSED:
                _state.replace_assurance(
                    existing,
                    replace(
                        existing,
                        state=_assurance.DELIVERED_NOT_WITNESSED,
                        error="Settlement: Scruple has no record of this content hash.",
                    ),
                )
            break
