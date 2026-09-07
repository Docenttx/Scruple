"""The offline retry queue -- the SDK's, now.

gap.json calls lib/queue_store.py "THE HEADLINE FINDING OF THIS
INVENTORY": it was imported by exactly one file in the repository and
that file was its own test. Nothing in lib/, operators/, panels/ or
__init__.py ever constructed a QueueStore. It was a tested, working,
never-called module.

So these tests keep the mechanical coverage (backoff, remove, cap) AND
add the one the old file could not have had: that the queue is now
reached from the failure path without anybody calling it. That test is
in test_client.py::test_a_5xx_on_witness_is_queued_before_the_caller_hears_about_it
and its control is
test_a_failed_query_is_NOT_queued. Below is the store itself.

Two mechanical differences from the old store, both noted in gap.json:
entries are keyed by a uuid `id` rather than by float `queued_at` (which
collides when two captures land in the same clock tick), and `drain()`
exists.
"""

from __future__ import annotations

from scruple_host_sdk.queue import BACKOFF_SCHEDULE, QueueStore


def _q(tmp_path) -> QueueStore:
    return QueueStore(str(tmp_path / "queue.jsonl"))


def test_enqueue_and_load(tmp_path):
    q = _q(tmp_path)
    q.enqueue(kind="witness", method="POST", path="/api/v2/witness", body={"n": 1})
    q.enqueue(kind="mark", method="POST", path="/api/v2/mark", body={"n": 2})
    assert q.count() == 2
    entries = q.load_all()
    assert entries[0]["body"]["n"] == 1
    assert entries[0]["attempts"] == 0
    assert entries[0]["last_attempt_at"] is None


def test_entries_are_keyed_by_a_unique_id_not_a_timestamp(tmp_path):
    """Two captures in the same clock tick used to share a key, so
    removing one removed both."""
    q = _q(tmp_path)
    a = q.enqueue(kind="witness", method="POST", path="/api/v2/witness", body={"n": 1})
    b = q.enqueue(kind="witness", method="POST", path="/api/v2/witness", body={"n": 2})
    assert a["id"] != b["id"]
    q.remove(a)
    assert [e["body"]["n"] for e in q.load_all()] == [2]


def test_due_now_returns_unattempted(tmp_path):
    q = _q(tmp_path)
    q.enqueue(kind="witness", method="POST", path="/p")
    assert len(q.due_now(now=1700000000)) == 1


def test_due_now_respects_backoff(tmp_path):
    q = _q(tmp_path)
    q.enqueue(kind="witness", method="POST", path="/p")
    [entry] = q.load_all()
    q.mark_attempted(entry)
    [entry2] = q.load_all()
    assert entry2["attempts"] == 1
    assert len(q.due_now(now=entry2["last_attempt_at"] + 1)) == 0
    assert len(q.due_now(now=entry2["last_attempt_at"] + 10)) == 1


def test_backoff_schedule_caps(tmp_path):
    q = _q(tmp_path)
    q.enqueue(kind="witness", method="POST", path="/p")
    for _ in range(10):
        [e] = q.load_all()
        q.mark_attempted(e)
    [final] = q.load_all()
    assert final["attempts"] == 10
    assert len(q.due_now(now=final["last_attempt_at"] + BACKOFF_SCHEDULE[-1] + 1)) == 1


def test_drain_removes_what_succeeded_and_keeps_what_did_not(tmp_path):
    q = _q(tmp_path)
    q.enqueue(kind="witness", method="POST", path="/ok", body={"n": 1})
    q.enqueue(kind="witness", method="POST", path="/bad", body={"n": 2})

    class _R:
        def __init__(self, ok): self.ok = ok

    result = q.drain(lambda entry: _R(entry["path"] == "/ok"))
    assert result == {"succeeded": 1, "failed": 1, "remaining": 1}
    assert [e["path"] for e in q.load_all()] == ["/bad"]


def test_the_queue_survives_the_process(tmp_path):
    """It is a file, not an in-memory list -- a second QueueStore over
    the same path sees what the first spooled."""
    path = str(tmp_path / "queue.jsonl")
    QueueStore(path).enqueue(kind="witness", method="POST", path="/p", body={"n": 7})
    assert QueueStore(path).load_all()[0]["body"]["n"] == 7
