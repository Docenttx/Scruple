"""The capture ledger -- every capture this addon BELIEVED it produced.

WHY THIS EXISTS AND WHY IT IS NOT THE QUEUE.

`scruple_host_sdk.queue.QueueStore` is store-and-forward: a request that
could not be delivered, spooled on disk, replayed later, and REMOVED on
success. That is the first half of the banking mechanism
(`L2_AS_THE_VENDOR_FLOOR.md`, "Store-and-forward + settlement
reconciliation"). It cannot be the second half, and the reason is
structural rather than a matter of adding a field:

  * an entry that drains successfully is deleted, so the queue cannot say
    what HAS settled -- only what has not;
  * an entry that is lost -- a corrupted line, a `replace_all` that lost a
    race, a user deleting the spool file, a bug -- is lost silently,
    because the only record that it ever existed was the entry itself.

A reconciliation built on the queue alone therefore reports "all clear"
for exactly the case it exists to catch. Settlement needs a SECOND,
APPEND-MOSTLY record of intent, written BEFORE the request goes out, and
that is this file. A missing leaf is then a difference between two
records rather than the absence of one.

WHAT A LINE MEANS. One line is one capture this addon decided to witness,
recorded at the moment its content hash was computed and before any
network call. It is not evidence that anything was witnessed; it is
evidence that this client INTENDED to witness something, which is the only
thing a client can honestly assert on its own.

THE HONEST LIMIT, stated here rather than left to be discovered: this
ledger is written by the same process it measures. A capture that never
reached `record_intent()` -- a handler that did not fire, an addon that was
disabled, a code path someone removed -- leaves no line, and its absence
is invisible from here, exactly as `L2_AS_THE_VENDOR_FLOOR.md`'s Missing 2
describes for Kohya. Detecting THAT is the server's job and needs the H-4
component envelope (`component_id` + monotonic counter + MAC) on the wire;
see `docs/canon/blender-l2/04-STORE-AND-FORWARD.md` for what stands in the
way of the addon sending one today. A client ledger catches what the
client attempted and lost. It cannot catch what the client never
attempted.

DURABILITY. JSONL, one line per capture, appended with a single `write()`
of a line that ends in a newline. A partially written final line is
discarded on read rather than repaired -- see `load_all()`. Updates
rewrite the whole file through a temp file and `os.replace`, the same
shape `QueueStore.replace_all` uses, because the alternative is a
half-updated ledger and the whole point of the file is that it is
believed.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

# ---- the states a ledger line can be in --------------------------------
#
# These are the CAPTURE states from adapter/assurance.py, plus the two
# outcomes only settlement can establish. Kept as strings that match
# assurance's constants exactly so a tracker row and a ledger line never
# disagree about the same capture.

INTENDED = "intended"          #: written; the request has not returned yet
WITNESSED = "witnessed"        #: the server said it wrote a leaf
QUEUED = "queued"              #: spooled on disk, will be retried
REJECTED = "rejected"          #: 4xx. Not queued, will not come back
REFUSED_LOCALLY = "refused_locally"          #: never left this machine
DELIVERED_NOT_WITNESSED = "delivered_not_witnessed"

#: Settlement outcomes -- only `reconcile.py` writes these.
SETTLED = "settled"            #: the SERVER confirms this content hash
GAP = "gap"                    #: spent, not on the record, nothing left to retry


class LedgerStore:
    def __init__(self, path: str) -> None:
        self.path = path
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8"):
                pass

    # -- writing ---------------------------------------------------------

    def append(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
            f.flush()
            os.fsync(f.fileno())
        return entry

    def record_intent(
        self,
        *,
        kind: str,
        leaf_kind: Optional[str],
        mime: Optional[str],
        content_hash: Optional[str],
        filename: Optional[str],
        state: str = INTENDED,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Write one line, BEFORE the request. Returns the entry.

        `seq` is a monotonic counter over this ledger file. It is NOT the
        H-4 component counter -- nothing MACs it and the server never sees
        it -- and it is named `seq` rather than `counter` so the two are
        not read as the same thing. What it buys is an ordering an
        operator can talk about ("captures 4 and 7 are missing") and a way
        to spot a ledger that lost lines in the middle.
        """
        entry = {
            "id": uuid.uuid4().hex,
            "seq": self.next_seq(),
            "recorded_at": time.time(),
            "kind": kind,
            "leaf_kind": leaf_kind,
            "mime": mime,
            "content_hash": content_hash,
            "filename": filename,
            "state": state,
            "leaf_id": None,
            "queue_id": None,
            "error": error,
            # Settlement fields. `checked_at` is None until a settlement
            # actually ASKED the server; that is what keeps "we have not
            # checked" distinct from "we checked and it was there".
            "checked_at": None,
            "server_found": None,
        }
        return self.append(entry)

    def update(self, entry_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        """Rewrite one line in place. Returns the updated entry, or None
        when the id is not in the ledger.

        LINES THIS CANNOT PARSE ARE COPIED THROUGH VERBATIM, and that is
        not politeness. The rewrite goes line by line rather than
        `load_all()` + `replace_all()` because the obvious version quietly
        DELETES every damaged line every time settlement touches the file
        -- so the first reconciliation after a torn write would repair the
        ledger into looking clean, which is the precise failure this whole
        module exists to prevent. A line that cannot be read is evidence of
        a capture that can no longer be accounted for, and evidence is not
        tidied up.
        """
        if not os.path.exists(self.path):
            return None
        found: Optional[Dict[str, Any]] = None
        out_lines: List[str] = []
        with open(self.path, "r", encoding="utf-8") as f:
            for raw in f:
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    parsed = json.loads(stripped)
                except json.JSONDecodeError:
                    out_lines.append(stripped)
                    continue
                if isinstance(parsed, dict) and parsed.get("id") == entry_id:
                    parsed.update(fields)
                    found = parsed
                out_lines.append(json.dumps(parsed) if isinstance(parsed, dict) else stripped)
        if found is None:
            return None
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(out_lines) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        return found

    def replace_all(self, entries: List[Dict[str, Any]]) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    # -- reading ---------------------------------------------------------

    def load_all(self) -> List[Dict[str, Any]]:
        """Every line that parses, in write order.

        A trailing line that does not parse is DISCARDED, not repaired:
        it is a capture whose intent record did not finish being written,
        and inventing the missing half would put a content hash in the
        ledger that nothing computed. It is also counted -- see
        `damaged_lines()` -- because a ledger silently dropping lines is
        the failure this whole file exists to make visible.
        """
        out: List[Dict[str, Any]] = []
        if not os.path.exists(self.path):
            return out
        with open(self.path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    out.append(parsed)
        return out

    def damaged_lines(self) -> int:
        """Non-empty lines that did not parse. Reported by settlement
        rather than swallowed: an unreadable line is a capture this client
        can no longer account for, which is a weaker statement than a gap
        and a much stronger one than nothing."""
        n = 0
        if not os.path.exists(self.path):
            return 0
        with open(self.path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    n += 1
                    continue
                if not isinstance(parsed, dict):
                    n += 1
        return n

    def next_seq(self) -> int:
        entries = self.load_all()
        return 1 + max((int(e.get("seq") or 0) for e in entries), default=0)

    def count(self) -> int:
        return len(self.load_all())

    def get(self, entry_id: str) -> Optional[Dict[str, Any]]:
        for e in self.load_all():
            if e.get("id") == entry_id:
                return e
        return None

    def by_content_hash(self, content_hash: str) -> List[Dict[str, Any]]:
        return [e for e in self.load_all() if e.get("content_hash") == content_hash]

    def missing_seq(self) -> List[int]:
        """Sequence numbers between 1 and the highest recorded that have
        no line. A ledger that lost a line in the middle says so."""
        entries = self.load_all()
        if not entries:
            return []
        seen = {int(e.get("seq") or 0) for e in entries}
        top = max(seen)
        return [n for n in range(1, top + 1) if n not in seen]


# ---- the session ledger ------------------------------------------------
#
# One per (host, cache dir), beside the SDK's queue and for the same
# reason: both have to survive the process. Resolved lazily from the
# session Client so a test that installs its own Client gets its own
# ledger without a monkeypatch.

_LEDGER: Optional[LedgerStore] = None
_LEDGER_KEY: Optional[str] = None

LEDGER_FILENAME = "blender-capture-ledger.jsonl"


def ledger_path_for(queue_path: str) -> str:
    """The ledger that belongs beside a given queue file.

    Derived from the queue path rather than configured separately, because
    a ledger pointing at one session's captures and a queue holding
    another's would reconcile two unrelated things and report gaps that
    are not gaps.
    """
    return os.path.join(os.path.dirname(queue_path) or ".", LEDGER_FILENAME)


def get(client=None) -> Optional[LedgerStore]:
    """The ledger for the live session, or None when there is no Client.

    None rather than a ledger in a default location: a capture recorded
    against a path no session will ever reconcile is worse than no record,
    because it reads as evidence.
    """
    global _LEDGER, _LEDGER_KEY
    if client is None:
        from . import sdk as _sdk
        client = _sdk.peek_client()
    if client is None:
        return None
    path = ledger_path_for(client.queue.path)
    if _LEDGER is None or _LEDGER_KEY != path:
        _LEDGER = LedgerStore(path)
        _LEDGER_KEY = path
    return _LEDGER


def reset() -> None:
    """Drop the cached handle (not the file). Called by state.reset()."""
    global _LEDGER, _LEDGER_KEY
    _LEDGER = None
    _LEDGER_KEY = None
