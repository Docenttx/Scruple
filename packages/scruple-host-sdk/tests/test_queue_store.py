"""Port of the identical test suite every one of the six forks already
had for its queue_store.py (queue_store.py was never the problem --
wiring it in was). Kept here to prove the port preserved behavior."""

from __future__ import annotations

from scruple_host_sdk.queue import BACKOFF_SCHEDULE, QueueStore


def test_enqueue_and_load(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue(kind="witness", method="POST", path="/api/v2/witness", body={"a": 1})
    q.enqueue(kind="witness", method="POST", path="/api/v2/witness", body={"a": 2})
    assert q.count() == 2


def test_due_now_immediately_after_enqueue(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue(kind="witness", method="POST", path="/x", body={})
    assert len(q.due_now()) == 1


def test_backoff_delays_the_next_attempt(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue(kind="witness", method="POST", path="/x", body={})
    entry = q.due_now()[0]
    q.mark_attempted(entry)

    just_after = q.due_now(now=entry["queued_at"] + 1)
    assert just_after == []

    after_backoff = q.due_now(now=entry["queued_at"] + BACKOFF_SCHEDULE[0] + 100)
    assert len(after_backoff) == 1


def test_remove(tmp_path):
    q = QueueStore(str(tmp_path / "queue.jsonl"))
    q.enqueue(kind="witness", method="POST", path="/x", body={"n": 1})
    q.enqueue(kind="witness", method="POST", path="/x", body={"n": 2})
    entry = q.load_all()[0]
    q.remove(entry)
    assert q.count() == 1
    assert q.load_all()[0]["body"]["n"] == 2


def test_survives_process_restart(tmp_path):
    path = str(tmp_path / "queue.jsonl")
    q1 = QueueStore(path)
    q1.enqueue(kind="witness", method="POST", path="/x", body={"n": 1})
    q2 = QueueStore(path)  # simulates a fresh process reopening the same file
    assert q2.count() == 1
