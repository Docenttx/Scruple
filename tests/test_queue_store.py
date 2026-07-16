"""Tests for the offline retry queue (ported from Fusion)."""

from __future__ import annotations

from lib.queue_store import BACKOFF_SCHEDULE, QueueStore


def test_enqueue_and_load(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue({"leaf_id": 1, "payload": "a"})
    q.enqueue({"leaf_id": 2, "payload": "b"})
    assert q.count() == 2
    entries = q.load_all()
    assert entries[0]["leaf"]["leaf_id"] == 1
    assert entries[0]["attempts"] == 0
    assert entries[0]["last_attempt_at"] is None


def test_due_now_returns_unattempted(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue({"leaf_id": 1})
    due = q.due_now(now=1700000000)
    assert len(due) == 1


def test_due_now_respects_backoff(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue({"leaf_id": 1})
    [entry] = q.load_all()
    q.mark_attempted(entry)
    [entry2] = q.load_all()
    assert entry2["attempts"] == 1
    due = q.due_now(now=entry2["last_attempt_at"] + 1)
    assert len(due) == 0
    due = q.due_now(now=entry2["last_attempt_at"] + 10)
    assert len(due) == 1


def test_remove(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue({"leaf_id": 1})
    q.enqueue({"leaf_id": 2})
    [a, b] = q.load_all()
    q.remove(a)
    rest = q.load_all()
    assert len(rest) == 1
    assert rest[0]["leaf"]["leaf_id"] == 2


def test_backoff_schedule_caps(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue({"leaf_id": 1})
    for _ in range(10):
        [e] = q.load_all()
        q.mark_attempted(e)
    [final] = q.load_all()
    assert final["attempts"] == 10
    cap = BACKOFF_SCHEDULE[-1]
    due = q.due_now(now=final["last_attempt_at"] + cap + 1)
    assert len(due) == 1
