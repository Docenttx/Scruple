"""Offline retry queue for network calls that could not complete.

JSONL on disk, one line per queued request. If the host process crashes
between a failed submit() and the next successful drain, the queue
survives -- it is a file, not an in-memory list.

This is a near-direct port of the identical queue_store.py that existed,
byte-for-byte 93% identical, in all six forks -- tested in every one of
them and wired into the failure path in NONE of them (D-10, CANON_SKELETON
§5 property 3). The port itself is not the fix; http.submit() calling
enqueue() unconditionally on failure is the fix. See http.py.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800]


class QueueStore:
    def __init__(self, path: str) -> None:
        self.path = path
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8"):
                pass

    def enqueue(
        self,
        *,
        kind: str,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        entry = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "method": method,
            "path": path,
            "body": body,
            "queued_at": time.time(),
            "attempts": 0,
            "last_attempt_at": None,
        }
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        return entry

    def load_all(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not os.path.exists(self.path):
            return out
        with open(self.path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

    def replace_all(self, entries: List[Dict[str, Any]]) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        os.replace(tmp, self.path)

    def count(self) -> int:
        return len(self.load_all())

    def due_now(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        n = now if now is not None else time.time()
        out: List[Dict[str, Any]] = []
        for e in self.load_all():
            if e.get("last_attempt_at") is None:
                out.append(e)
                continue
            idx = min(max(e["attempts"] - 1, 0), len(BACKOFF_SCHEDULE) - 1)
            wait = BACKOFF_SCHEDULE[idx]
            if n - e["last_attempt_at"] >= wait:
                out.append(e)
        return out

    def mark_attempted(self, entry: Dict[str, Any]) -> None:
        all_entries = self.load_all()
        for e in all_entries:
            if e["id"] == entry["id"]:
                e["attempts"] += 1
                e["last_attempt_at"] = time.time()
        self.replace_all(all_entries)

    def remove(self, entry: Dict[str, Any]) -> None:
        all_entries = self.load_all()
        kept = [e for e in all_entries if e["id"] != entry["id"]]
        self.replace_all(kept)

    def drain(
        self,
        submit_fn: Callable[[Dict[str, Any]], Any],
        *,
        now: Optional[float] = None,
    ) -> Dict[str, int]:
        """Retry every due entry through `submit_fn`, which must return
        something with a truthy/falsy `.ok`. Callers (Client.detach())
        MUST pass a submit_fn that calls http.submit() with
        queue_kind=None -- draining an already-queued entry must never
        re-enqueue a second copy of itself on repeated failure. Backoff
        state (mark_attempted) already tracks the retry schedule; a
        second enqueue would duplicate the entry rather than reschedule
        it.
        """
        succeeded = 0
        failed = 0
        for entry in self.due_now(now=now):
            self.mark_attempted(entry)
            result = submit_fn(entry)
            if getattr(result, "ok", False):
                self.remove(entry)
                succeeded += 1
            else:
                failed += 1
        return {"succeeded": succeeded, "failed": failed, "remaining": self.count()}
