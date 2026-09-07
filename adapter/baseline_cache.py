"""The last baseline this build successfully established, on disk.

MEASURED FIRST, THEN WRITTEN. Probe, 2026-09-07, against the addon as
WO-B3 left it:

    client = new_client(...); opener.offline = True
    witness_render(client, scene)
      -> attach failed: could not establish or verify a baseline
      -> queued: False      error: Could not establish a Scruple baseline
      -> queue depth: 0

So a Blender started while the server is unreachable witnesses NOTHING,
and nothing is spooled -- every capture is refused client-side and the
store-and-forward queue never sees one. That is the case store-and-forward
is most for: a laptop on a train, a studio behind a dropped VPN, a machine
that was rebooted during an outage.

WHY IT HAPPENS, and why it is not a bug in the queue. `witness_flow.witness()`
refuses without `session.state.baseline_ref` (D-3: a leaf without a baseline
is not a weaker leaf, it is not Scruple-witnessed at all), `SessionState` is
in-memory, and `Client.attach()` is a network call. One Client per Blender
process therefore means one network call per Blender process before any
capture can happen, and `attach()` is deliberately NOT queued -- it is a
precondition, not a Phase-3 event.

WHAT THIS FILE DOES, AND THE THREE RULES IT WILL NOT BREAK.

  1. It caches `(baseline_ref, tamper_surface_hash)` after a LIVE attach --
     never after an offline one. A cached baseline is a fact the server
     stated, replayed; it is never a fact this client invented.

  2. It is used ONLY when `attach()` could not reach the server, and only
     when the tamper surface hash of the code running RIGHT NOW equals the
     one the cache was written under. Different bytes are a different
     integration (D-3 / Standard §4), and reusing a baseline across them
     would attach this session's leaves to a description of different
     code. That check is why this is not simply "remember the last ref".

  3. It never makes a leaf look better than it is. A session running on a
     cached baseline is recorded as such -- `restored_offline` on the
     result, an error line on the panel -- and every capture it takes goes
     into the QUEUE, where the server gets the final say: `/api/v2/witness`
     validates `baseline_ref` at ingest and refuses a retired or unknown
     one. A stale baseline therefore surfaces as a rejection at drain time,
     which is visible, rather than as silence, which is not.

The alternative was to leave it as it was: capture nothing offline, and
report a refusal. That is honest too, and it is also the exact shape of
"a capture path that has gone dark produces the same observable as a quiet
afternoon" -- the refusals are on the ledger now, but the evidence is gone
either way. Preserving the capture and letting the server adjudicate the
baseline is the better trade, and the reason it is safe is rule 2.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

CACHE_FILENAME = "blender-baseline.json"
CACHE_VERSION = 1


def cache_path_for(queue_path: str) -> str:
    """Beside the queue and the ledger. All three describe one profile's
    session state and separating them would let a queue be drained against
    a baseline from a different install."""
    return os.path.join(os.path.dirname(queue_path) or ".", CACHE_FILENAME)


@dataclass(frozen=True)
class CachedBaseline:
    baseline_ref: str
    tamper_surface_hash: Optional[str]
    verified_at: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "v": CACHE_VERSION,
            "baseline_ref": self.baseline_ref,
            "tamper_surface_hash": self.tamper_surface_hash,
            "verified_at": self.verified_at,
        }


def save(client) -> Optional[CachedBaseline]:
    """Record the baseline this session established. No-op unless the
    session actually has one -- there is nothing to cache after a failed
    attach, and writing a null would make `load()` have to distinguish
    two kinds of absence."""
    ref = getattr(client.state, "baseline_ref", None)
    if not ref:
        return None
    entry = CachedBaseline(
        baseline_ref=ref,
        tamper_surface_hash=getattr(client.state, "tamper_surface_hash", None),
        verified_at=time.time(),
    )
    path = cache_path_for(client.queue.path)
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entry.as_dict(), f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return entry


def load(client) -> Optional[CachedBaseline]:
    """The cached baseline, or None. An unreadable or wrong-version file
    is None rather than an error: a cache that cannot be read is a cache
    that is not there, and the caller's offline branch is the same either
    way."""
    path = cache_path_for(client.queue.path)
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("v") != CACHE_VERSION:
        return None
    ref = doc.get("baseline_ref")
    if not isinstance(ref, str) or not ref:
        return None
    return CachedBaseline(
        baseline_ref=ref,
        tamper_surface_hash=doc.get("tamper_surface_hash"),
        verified_at=float(doc.get("verified_at") or 0.0),
    )


def restore_if_same_build(client, current_tamper_surface_hash: str) -> Optional[CachedBaseline]:
    """Put a cached baseline back on the session, IF it describes this build.

    Returns the entry it restored, or None -- and None covers both "there
    is no cache" and "the cache is for different code". The caller must not
    tell those apart by inspecting the file: in both cases this session has
    no baseline it is entitled to use, and any behaviour that differed
    between them would be a way to smuggle one in.
    """
    entry = load(client)
    if entry is None:
        return None
    if entry.tamper_surface_hash != current_tamper_surface_hash:
        return None
    client.state.baseline_ref = entry.baseline_ref
    client.state.tamper_surface_hash = entry.tamper_surface_hash
    return entry


def clear(client) -> None:
    try:
        os.remove(cache_path_for(client.queue.path))
    except OSError:
        pass
