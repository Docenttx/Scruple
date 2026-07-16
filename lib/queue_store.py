"""Offline retry queue for witness POSTs that failed mid-flight.

JSONL at <addon_data>/queue.jsonl. If Blender crashes between capture
and ack the next successful witness drains the queue in order.
Exponential backoff, capped at 30 minutes.

Direct port of /data/scruple-fusion/lib/queue_store.py.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800]


class QueueStore:
    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                f.write("")

    def enqueue(self, leaf: Dict[str, Any]) -> None:
        entry = {
            "queued_at": time.time(),
            "attempts": 0,
            "last_attempt_at": None,
            "leaf": leaf,
        }
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

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
            if e["last_attempt_at"] is None:
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
            if e["queued_at"] == entry["queued_at"]:
                e["attempts"] += 1
                e["last_attempt_at"] = time.time()
        self.replace_all(all_entries)

    def remove(self, entry: Dict[str, Any]) -> None:
        all_entries = self.load_all()
        kept = [e for e in all_entries if e["queued_at"] != entry["queued_at"]]
        self.replace_all(kept)
