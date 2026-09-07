"""The Blender-side state bag -- and only that.

gap.json, modules row 7: "Neither holds the other's, so WO-B2 needs
both: the SDK's SessionState plus a small Blender-side bag for the
project the panel shows."

So the split is:

  * `scruple_host_sdk.state.SessionState`, which lives on the Client --
    baseline_ref, tamper_surface_hash, the recent-receipt history, the
    capabilities cache. Everything the SDK writes, the SDK owns. Read it
    through `session_state()`; nothing here copies it.
  * this module -- what the N-panel shows that the SDK has no opinion
    about: the active project, the payment-method summary, the last leaf
    a paid action can be applied to, and the last error to surface.

`last_error` is here rather than on SessionState because an error can
happen before there is a Client at all (not signed in, no key on disk),
and a field the panel reads must exist in that state too.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Deque, Dict, List, Optional

from . import sdk as _sdk


#: How many captures the tracker remembers. Larger than the SDK's five
#: receipts because a Blender session renders animation frames in bursts.
MAX_ASSURANCES = 50


class BlenderState:
    def __init__(self) -> None:
        # v1 had /api/projects; v2 keeps project as an optional int on the
        # leaf and exposes no list/create route (gap.json, endpoints rows
        # 1-3: "no_equivalent"). So nothing sets these today -- they are
        # here because the panel reads them and WO-B5 owns the switcher.
        self.active_project_id: Optional[int] = None
        self.active_project_name: Optional[str] = None
        self.active_project_status: Optional[str] = None

        self.payment_method_summary: Optional[str] = None
        # WO-B5. The whole /api/stripe/config body, not just the card
        # summary: `price_cents_for()` reads `prices` off it, and a
        # dashboard that shows a price has to show the one the confirm
        # dialog will use. Cached because draw() must not fetch.
        self.payment_config: Optional[Dict[str, Any]] = None
        #: Why the last read of /api/stripe/config failed, or None. A
        #: separate field from `payment_config` because "never asked" and
        #: "asked and was refused" block the paid buttons for different
        #: reasons and only one of them is the user's to fix.
        self.payment_error: Optional[str] = None

        # What a paid action would be applied to: /v2/mark takes a
        # leaf_id, so the addon has to remember which leaf the last
        # witness produced. v1 marked a whole project, which is why no
        # field like this existed before.
        self.last_leaf_id: Optional[str] = None
        self.last_leaf_mime: Optional[str] = None
        self.last_content_hash: Optional[str] = None

        self.last_error: Optional[str] = None

        # WO-B5. One MarkRecord per leaf this session marked, keyed by
        # leaf_id. Not a list: a leaf can be marked more than once (a
        # local lock and then a chain anchor), and the dashboard shows
        # the current position of a leaf, not a transaction log -- the
        # durable log is the server's.
        self.marks: Dict[str, Any] = {}

        # Which capture the receipt drill-down is showing. A KEY (see
        # `assurance.capture_key`), not an index and not the record
        # object: the tracker is a deque that new captures push onto the
        # front, so an index would silently drift onto a different row,
        # and `replace_assurance()` swaps the object when a settlement
        # updates a capture, so identity would not survive either.
        # None means "the newest", which is what a drill-down opened
        # without a click should show.
        self.selected_capture_key: Optional[str] = None

        # WO-B3. One LeafAssurance per capture this session, newest first,
        # INCLUDING the ones that never reached the server.
        #
        # It is a second list beside the SDK's `SessionState.recent_receipts`
        # rather than an extension of it, and that is deliberate: the SDK
        # records a receipt only inside `witness_file()`, so a capture the
        # adapter refused before calling the SDK -- an unmappable kind, an
        # undeclarable MIME, no baseline -- produces no receipt at all. A
        # tracker built on receipts alone would show a quiet afternoon
        # where there were four refusals, which is the exact shape of the
        # silence vendor floor item 5 exists to make visible.
        self.assurances: Deque[Any] = deque(maxlen=MAX_ASSURANCES)

        # WO-B4. The most recent settlement (adapter/reconcile.py), or
        # None when one has never run in this session. None is NOT
        # "clear" -- the panel prints "never reconciled", because a
        # settlement that has not happened and one that found nothing
        # missing are the two answers this addon exists to keep apart.
        self.last_reconciliation: Any = None

    def clear(self) -> None:
        self.__init__()  # one definition of what the fields are


STATE = BlenderState()


def get() -> BlenderState:
    return STATE


def reset() -> None:
    """Clear the Blender bag AND drop the session Client, so a test or a
    sign-out does not leave a half-live session behind."""
    from . import ledger as _ledger

    STATE.clear()
    _sdk.reset_client()
    # The project index is a cache of a server response tied to the
    # session's key; a new session must not inherit the old tenant's
    # project list.
    from . import projects as _projects

    _projects.reset()
    # The ledger HANDLE, not the file. A ledger deleted on sign-out would
    # destroy the only record of captures that have not settled yet, which
    # is the opposite of what it is for.
    _ledger.reset()


def set_error(message: Optional[str]) -> None:
    STATE.last_error = message


def remember_leaf(*, leaf_id: Optional[str], mime: Optional[str], content_hash: Optional[str]) -> None:
    STATE.last_leaf_id = leaf_id
    STATE.last_leaf_mime = mime
    STATE.last_content_hash = content_hash


def session_state():
    """The SDK's SessionState for the live session, or None when there is
    no Client yet. Not cached here -- one copy, on the Client."""
    client = _sdk.peek_client()
    return client.state if client is not None else None


def recent_receipts() -> List[Dict[str, Any]]:
    """Receipts as the SDK recorded them (Client.witness_file appends to
    SessionState.recent_receipts). Empty before the first witness."""
    st = session_state()
    return list(st.recent_receipts) if st is not None else []


def queue_depth() -> int:
    """How many requests are spooled on disk waiting to be replayed. 0
    when there is no session yet -- not "unknown", because a session with
    no Client has never enqueued anything."""
    client = _sdk.peek_client()
    return client.queue_depth if client is not None else 0


def record_assurance(record, *, replace_leaf_id: Optional[str] = None) -> None:
    """Remember one capture's assurance record, newest first.

    `replace_leaf_id` updates in place instead of appending -- used when
    `flow.resolve_assurance()` folds a receipt and a verification into a
    record that is already in the tracker. Appending a second entry for
    the same leaf would make one capture look like two, and a tracker
    that miscounts captures is worse than no tracker.
    """
    if replace_leaf_id:
        for i, existing in enumerate(STATE.assurances):
            if getattr(existing, "leaf_id", None) == replace_leaf_id:
                STATE.assurances[i] = record
                return
    STATE.assurances.appendleft(record)


def assurances() -> List[Any]:
    """Every capture this session, newest first, refusals included."""
    return list(STATE.assurances)


def last_assurance():
    """The most recent capture, or None before the first one."""
    return STATE.assurances[0] if STATE.assurances else None


def assurance_for(leaf_id: str):
    for rec in STATE.assurances:
        if getattr(rec, "leaf_id", None) == leaf_id:
            return rec
    return None


def state_counts() -> Dict[str, int]:
    """How many captures are in each measurement state. What a tracker
    header shows, and what makes "three queued, one rejected" legible
    without expanding the list."""
    counts: Dict[str, int] = {}
    for rec in STATE.assurances:
        counts[rec.state] = counts.get(rec.state, 0) + 1
    return counts


# ---- WO-B4: settlement ---------------------------------------------------


def record_reconciliation(rec) -> None:
    """Remember the most recent settlement. One, not a history: the panel
    shows the current position, and the durable history is the ledger
    file itself."""
    STATE.last_reconciliation = rec


def last_reconciliation():
    """The last settlement, or None if none has run.

    None is a distinct answer and callers must render it as one. An
    addon that has never reconciled knows nothing about whether its
    captures are on the record; that is not the same as knowing they are.
    """
    return STATE.last_reconciliation


def replace_assurance(existing, updated) -> bool:
    """Swap one tracker row for another, in place, preserving order.

    Used by settlement when a capture's state changes AFTER the capture --
    a queued leaf that drained, or a leaf the server turns out not to
    have. Appending instead would make one capture look like two, which is
    the same reason `record_assurance` has `replace_leaf_id`.
    """
    for i, rec in enumerate(STATE.assurances):
        if rec is existing:
            STATE.assurances[i] = updated
            return True
    return False


def queue_is_backed_up() -> bool:
    """True when anything is spooled and undelivered. What an offline
    indicator reads -- a boolean over `queue_depth()` so a panel does not
    have to decide what "offline" means."""
    return queue_depth() > 0


def ledger_depth() -> int:
    """How many captures this session's ledger has recorded, ever. 0 when
    there is no session -- not "unknown", for the same reason
    `queue_depth()` returns 0."""
    from . import ledger as _ledger

    led = _ledger.get()
    return led.count() if led is not None else 0


# ---- WO-B5: the dashboard's reads ---------------------------------------


def set_payment_config(config: Optional[Dict[str, Any]], *, error: Optional[str] = None) -> None:
    """Cache /api/stripe/config and the card summary derived from it, in
    one place, so the price on a button and the price in the confirm
    dialog come from the same body. `error` is why the read failed, and
    it is recorded rather than collapsed into an absent config."""
    from scruple_host_sdk import payment as _payment

    STATE.payment_config = config
    STATE.payment_error = error
    STATE.payment_method_summary = _payment.payment_method_summary(config or {})


def payment_config() -> Optional[Dict[str, Any]]:
    return STATE.payment_config


def payment_ready() -> bool:
    """True only when a card summary was actually read off a fetched
    config. False before the config has ever been fetched -- "not asked"
    renders as "cannot pay yet", which is the safe direction: it blocks
    a button rather than offering one that would fail."""
    return bool(STATE.payment_method_summary)


def record_mark(record) -> None:
    """Remember what a paid action did to a leaf."""
    if getattr(record, "leaf_id", None):
        STATE.marks[record.leaf_id] = record


def mark_for(leaf_id: Optional[str]):
    """The last mark applied to this leaf, or None if it was never
    marked. None is not "unlocked by choice" -- it is "no paid action was
    attempted", and locks.state_line() says so."""
    if not leaf_id:
        return None
    return STATE.marks.get(leaf_id)


def select_capture(key: Optional[str]) -> None:
    STATE.selected_capture_key = key


def selected_capture():
    """The capture the drill-down is showing: the one whose key was
    selected, or the newest when nothing was.

    Falls back to the newest when the selected key is no longer in the
    tracker (the deque is bounded at MAX_ASSURANCES, so a long session
    drops old rows) rather than showing nothing -- but it does NOT
    silently keep the stale key, so the next selection is honest.
    """
    from . import assurance as _assurance

    key = STATE.selected_capture_key
    if key is not None:
        for rec in STATE.assurances:
            if _assurance.capture_key(rec) == key:
                return rec
    return last_assurance()
