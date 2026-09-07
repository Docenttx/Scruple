"""WO-S1(b) · AN SDK CALLER CAN SEND AN H-4 §4.3 COMPONENT ENVELOPE.

THE GAP THIS CLOSES
-------------------
`witness_flow.witness()` accepted `attestation` and `continuity` and
stopped. There was no `component`/`mac`/`capture` parameter, so no SDK
client could take part in per-component sequence accounting -- even though
both halves already worked end to end against the live route:

    POST /api/v2/components/provision  -> component_id, ik_hex, counter 0
    Ratchet(IK,0).mac(component_preimage(body)); POST /api/v2/witness
      -> component {"counter":0,"verified":true,"gap":0}
    skip counter 1, send counter 2
      -> component {"counter":2,"verified":true,"gap":1}

CANON_SKELETON §5 forbids an adapter assembling its own envelope, so the
addon could not work around it; it had to be the SDK.

WHY THE FAKE SERVER HERE ACTUALLY VERIFIES
------------------------------------------
A stub that accepted any `mac` would let `witness()` MAC the wrong field
set, over the wrong counter, forever. `_RatchetingServer` below derives the
same IK, ratchets in lockstep and recomputes the HMAC over
`component_preimage(submitted_body)` -- so a MAC over a field set the server
cannot reconstruct FAILS here, which is exactly the failure mode
`component_preimage`'s docstring exists to name.

That is self-consistency between two Python callers, and it is worth what
it is worth. What makes it evidence rather than circularity is that both
halves are already pinned across languages by fixtures this suite runs:
`test/vectors/ratchet-vectors.json` for the key schedule
(`test_ratchet.py`) and `test/vectors/component-preimage-vectors.json` for
the field set (`test_server_library.py`). The cross-language proof against
the real TypeScript route is the live run recorded in the WO report.

EVERY CLAIM HAS A CONTROL. In particular the gap detector is checked in
both directions: a skipped counter must report `gap: 1` AND an unskipped
sequence must report `gap: 0`, because a detector that always says yes is
not a detector.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Dict, List, Optional, Tuple

import pytest

from scruple_host_sdk import witness_flow
from scruple_host_sdk.ratchet import Ratchet, canonical_preimage, derive_ik, hkdf_expand
from scruple_host_sdk.server_library import component_preimage

BDK = bytes.fromhex("5c" * 32)
BASELINE = "a" * 64
COMPONENT_ID = "c0ffee00-0000-4000-8000-000000000001"


def _mac_at(ik: bytes, counter: int, preimage: Dict[str, Any]) -> str:
    """The server's half: ratchet a fresh chain to `counter`, MAC there.

    Written out rather than reusing the client's Ratchet object, so a bug
    that advanced the client's chain twice cannot hide behind the same
    object being used on both sides.
    """
    k = ik
    for _ in range(counter):
        k = hkdf_expand(k, b"scruple/ratchet/v1", 32)
    m = hkdf_expand(k, b"scruple/mac/v1", 32)
    return hmac.new(m, canonical_preimage(preimage), hashlib.sha256).hexdigest()


class _RatchetingServer:
    """A stand-in for POST /api/v2/witness that does the two things that
    matter: it CHECKS the MAC, and it accounts for skipped counters."""

    def __init__(self, ik: bytes) -> None:
        self.ik = ik
        self.expected_next: Dict[str, int] = {}
        self.bodies: List[Dict[str, Any]] = []
        self.rejected: List[str] = []

    def respond(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        self.bodies.append(body)
        base: Dict[str, Any] = {
            "leaf_id": str(len(self.bodies)),
            "leaf_hash": "f" * 64,
            "witnessed": True,
            "leaf_scheme": "v2",
            "baseline_ref": body.get("baseline_ref"),
            # Stated on every response, including when null -- the route
            # does the same, "because an absent key is a fact nobody reads".
            "component": None,
            "component_verified": False,
        }
        comp = body.get("component")
        if not comp:
            return 201, base

        cid = comp["component_id"]
        counter = comp["counter"]
        want = _mac_at(self.ik, counter, component_preimage(body))
        if body.get("mac") != want:
            self.rejected.append(f"{cid}@{counter}")
            return 400, {"error": {"code": "component_unverified"}}

        expected = self.expected_next.get(cid, 0)
        gap = max(0, counter - expected)
        self.expected_next[cid] = counter + 1
        base["component"] = {
            "component_id": cid,
            "counter": counter,
            "verified": True,
            "gap": gap,
            "build_changed": False,
        }
        base["component_verified"] = True
        return 201, base


class _RatchetingOpener:
    """FakeOpener's shape, but scripted by a server instead of a list."""

    def __init__(self, server: _RatchetingServer) -> None:
        self.server = server
        self.calls: List[Dict[str, Any]] = []

    def urlopen(self, req: Any, timeout: Optional[float] = None) -> Any:
        body = json.loads(req.data) if req.data else None
        self.calls.append({"url": req.full_url, "method": req.get_method(), "body": body})
        status, payload = self.server.respond(body or {})
        if status >= 400:
            import io
            import urllib.error

            raise urllib.error.HTTPError(
                req.full_url, status, "error", {}, io.BytesIO(json.dumps(payload).encode())
            )

        class _R:
            def getcode(self_inner) -> int:
                return status

            def read(self_inner) -> bytes:
                return json.dumps(payload).encode("utf-8")

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc) -> bool:
                return False

        return _R()


@pytest.fixture
def rig(tmp_path):
    """A client whose transport is a MAC-checking server, plus the
    component's own ratchet at counter 0."""
    from scruple_host_sdk.client import Client

    ik = bytes(derive_ik(BDK, COMPONENT_ID))
    server = _RatchetingServer(ik)
    opener = _RatchetingOpener(server)
    client = Client(
        host="blender",
        integration_version="1.0.0",
        api_key="sk_test_s1b",
        base_url="https://scruple.test",
        opener=opener,
        cache_dir=str(tmp_path / ".scruple"),
        queue_path=str(tmp_path / "queue.jsonl"),
    )
    client.state.baseline_ref = BASELINE
    return client, server, opener, Ratchet(ik, 0), ik


def _envelope(**over: Any) -> Dict[str, Any]:
    e: Dict[str, Any] = {
        "component_id": COMPONENT_ID,
        "build_measurement": "sha256:" + "1" * 64,
        "attestation": {"provider": "none", "quote_ref": None},
    }
    e.update(over)
    return e


# ---------------------------------------------------------------------------
# 1. The envelope goes out, MACed over the body that was actually sent
# ---------------------------------------------------------------------------


def test_witness_sends_a_component_envelope_and_the_server_verifies_it(rig):
    client, server, opener, ratchet, ik = rig

    outcome = witness_flow.witness(
        client,
        kind="artifact",
        content_hash="b" * 64,
        mime="image/png",
        component=_envelope(),
        ratchet=ratchet,
    )

    sent = opener.calls[0]["body"]
    assert sent["component"]["component_id"] == COMPONENT_ID
    assert sent["component"]["counter"] == 0
    assert "mac" in sent and len(sent["mac"]) == 64
    assert server.rejected == [], "the MAC must verify against the field set the server rebuilds"

    assert outcome.component is not None
    assert outcome.component.verified is True
    assert outcome.component.counter == 0
    assert outcome.component.gap == 0


def test_CONTROL_a_caller_that_sends_no_envelope_behaves_exactly_as_before(rig):
    client, server, opener, ratchet, ik = rig

    outcome = witness_flow.witness(client, kind="artifact", content_hash="c" * 64, mime="image/png")

    sent = opener.calls[0]["body"]
    for absent in ("component", "mac", "capture", "input_hash", "model_fingerprints_hash"):
        assert absent not in sent, f"{absent} must not appear when the caller did not send one"
    # None, not a hollow ComponentOutcome: "this leaf carries no component"
    # is a fact, and a zero-valued object would read as a checked one.
    assert outcome.component is None
    assert outcome.witnessed is True
    # And the ratchet was never touched -- no counter was spent.
    assert ratchet.counter == 0


def test_the_mac_covers_the_capture_block_and_the_input_hashes(rig):
    """Every one of these is a component_preimage field. A parameter the
    SDK cannot send is a field a component cannot MAC honestly, which is
    why `input_hash` and `model_fingerprints_hash` came along too."""
    client, server, opener, ratchet, ik = rig

    witness_flow.witness(
        client,
        kind="artifact",
        content_hash="d" * 64,
        mime="image/png",
        input_hash="e" * 64,
        model_fingerprints_hash="f" * 64,
        component=_envelope(),
        capture={"surface": "bpy.app.handlers", "hook": "save_post", "fidelity": "exact"},
        ratchet=ratchet,
    )

    sent = opener.calls[0]["body"]
    assert sent["input_hash"] == "e" * 64
    assert sent["model_fingerprints_hash"] == "f" * 64
    assert sent["capture"]["hook"] == "save_post"
    assert server.rejected == []

    # CONTROL: the capture block is genuinely IN the preimage. Recompute the
    # MAC over the same body with one capture field changed; it must differ.
    altered = json.loads(json.dumps(sent))
    altered["capture"]["hook"] = "save_pre"
    assert _mac_at(ik, 0, component_preimage(altered)) != sent["mac"]


def test_the_callers_envelope_dict_is_not_mutated(rig):
    """A component's envelope is usually a long-lived dict. Stamping this
    event's counter into it would make the next call carry a stale one."""
    client, server, opener, ratchet, ik = rig
    env = _envelope()
    witness_flow.witness(
        client, kind="artifact", content_hash="a" * 64, mime="image/png",
        component=env, ratchet=ratchet,
    )
    assert "counter" not in env


def test_a_stale_counter_in_the_envelope_is_overridden_by_the_ratchet(rig):
    """The ratchet owns the counter. A caller that passes 99 gets the
    counter it actually spent -- otherwise the MAC covers a counter the
    component never used and the envelope authenticates nothing."""
    client, server, opener, ratchet, ik = rig
    witness_flow.witness(
        client, kind="artifact", content_hash="a" * 64, mime="image/png",
        component=_envelope(counter=99), ratchet=ratchet,
    )
    assert opener.calls[0]["body"]["component"]["counter"] == 0
    assert server.rejected == []


# ---------------------------------------------------------------------------
# 2. THE GAP — in both directions
# ---------------------------------------------------------------------------


def test_a_skipped_counter_is_reported_as_a_gap(rig):
    """The WO's sequence, through the SDK: counter 0 delivered, counter 1
    spent and never sent, counter 2 delivered -> gap 1."""
    client, server, opener, ratchet, ik = rig

    first = witness_flow.witness(
        client, kind="artifact", content_hash="1" * 64, mime="image/png",
        component=_envelope(), ratchet=ratchet,
    )
    assert first.component.counter == 0
    assert first.component.gap == 0

    # THE SUPPRESSED EVENT. Counter 1 is spent on a MAC that is never sent
    # -- the shape of a capture that happened and did not reach the record.
    ratchet.mac(component_preimage({"content_hash": "2" * 64, "component": {"component_id": COMPONENT_ID, "counter": 1}}))
    assert ratchet.counter == 2

    third = witness_flow.witness(
        client, kind="artifact", content_hash="3" * 64, mime="image/png",
        component=_envelope(), ratchet=ratchet,
    )
    assert third.component.counter == 2
    assert third.component.verified is True
    assert third.component.gap == 1, "the counter the component spent and never delivered"
    # §4.2 — a gap does not invalidate the leaf it is reported on.
    assert third.witnessed is True
    assert third.leaf_id is not None


def test_CONTROL_an_unskipped_sequence_reports_no_gap(rig):
    """Otherwise the gap detector is just always saying yes."""
    client, server, opener, ratchet, ik = rig

    gaps = []
    for i in range(4):
        o = witness_flow.witness(
            client, kind="artifact", content_hash=str(i) * 64, mime="image/png",
            component=_envelope(), ratchet=ratchet,
        )
        gaps.append(o.component.gap)
        assert o.component.counter == i

    assert gaps == [0, 0, 0, 0]
    assert server.rejected == []


def test_the_gap_is_read_from_the_body_and_never_inferred(rig):
    """D-8, field by field. A server that reports verified=True with a gap
    of 3 is the interesting case, and a reader that derives gap from
    verified erases it."""
    o = witness_flow._component_outcome(
        {"component_id": "x", "counter": 7, "verified": True, "gap": 3, "build_changed": True}
    )
    assert (o.gap, o.verified, o.build_changed) == (3, True, True)
    # Absent component -> None, not a zero-valued object.
    assert witness_flow._component_outcome(None) is None
    # And a missing gap on a present component is 0, not "unknown" --
    # the route always sends it.
    assert witness_flow._component_outcome({"component_id": "x", "counter": 0, "verified": True}).gap == 0


# ---------------------------------------------------------------------------
# 3. Refused client-side, with NO network call
# ---------------------------------------------------------------------------


def test_CONTROL_an_envelope_with_no_mac_is_refused_before_anything_is_sent(rig):
    client, server, opener, ratchet, ik = rig
    with pytest.raises(ValueError, match="no `mac` and no `ratchet`"):
        witness_flow.witness(
            client, kind="artifact", content_hash="a" * 64, mime="image/png",
            component=_envelope(counter=0),
        )
    assert opener.calls == [], "nothing may go on the wire"
    assert ratchet.counter == 0, "and no counter may be spent"


def test_CONTROL_a_mac_with_no_envelope_is_refused_before_anything_is_sent(rig):
    client, server, opener, ratchet, ik = rig
    with pytest.raises(ValueError, match="no `component` envelope"):
        witness_flow.witness(
            client, kind="artifact", content_hash="a" * 64, mime="image/png", mac="0" * 64,
        )
    assert opener.calls == []


def test_CONTROL_both_a_mac_and_a_ratchet_is_refused_rather_than_one_silently_dropped(rig):
    client, server, opener, ratchet, ik = rig
    with pytest.raises(ValueError, match="BOTH"):
        witness_flow.witness(
            client, kind="artifact", content_hash="a" * 64, mime="image/png",
            component=_envelope(counter=0), mac="0" * 64, ratchet=ratchet,
        )
    assert opener.calls == []
    assert ratchet.counter == 0


def test_CONTROL_a_capture_block_with_no_component_is_refused(rig):
    """`capture` is what the COMPONENT saw. The route reads it only through
    the component preimage, so alone it is an unauthenticated observation
    nothing commits to."""
    client, server, opener, ratchet, ik = rig
    with pytest.raises(ValueError, match="no `component`"):
        witness_flow.witness(
            client, kind="artifact", content_hash="a" * 64, mime="image/png",
            capture={"surface": "bpy"},
        )
    assert opener.calls == []


def test_a_pre_maced_envelope_must_carry_its_counter(rig):
    client, server, opener, ratchet, ik = rig
    with pytest.raises(ValueError, match="no `counter`"):
        witness_flow.witness(
            client, kind="artifact", content_hash="a" * 64, mime="image/png",
            component=_envelope(), mac="0" * 64,
        )
    assert opener.calls == []


def test_the_pre_maced_path_works_when_the_caller_did_it_right(rig):
    """`mac=` is supported, and this is what it costs: the caller has to
    build the same body twice and get the field set right both times."""
    client, server, opener, ratchet, ik = rig
    body_for_mac = {
        "baseline_ref": BASELINE,
        "kind": "artifact",
        "content_hash": "9" * 64,
        "mime": "image/png",
        "component": _envelope(counter=0),
    }
    spent, tag = ratchet.mac(component_preimage(body_for_mac))
    assert spent == 0

    outcome = witness_flow.witness(
        client, kind="artifact", content_hash="9" * 64, mime="image/png",
        component=_envelope(counter=0), mac=tag,
    )
    assert server.rejected == []
    assert outcome.component.verified is True


# ---------------------------------------------------------------------------
# 4. The queue — one counter per event, even across a retry
# ---------------------------------------------------------------------------


def test_a_queued_submission_keeps_its_mac_and_burns_only_one_counter(rig, tmp_path):
    """§5's ordering: derive, MAC, ratchet, THEN enqueue. The counter is
    spent when the MAC is computed, not when the submission succeeds. A
    retry re-sends the SAME bytes, which the route drops idempotently --
    re-MACing would burn a second counter for one event and manufacture
    the very gap this machinery exists to detect."""
    client, server, opener, ratchet, ik = rig

    class _Down:
        calls: List[Any] = []

        def urlopen(self, req: Any, timeout: Optional[float] = None) -> Any:
            import urllib.error

            raise urllib.error.URLError("connection refused")

    client.opener = _Down()
    outcome = witness_flow.witness(
        client, kind="artifact", content_hash="7" * 64, mime="image/png",
        component=_envelope(), ratchet=ratchet,
    )
    assert outcome.queued is True
    assert outcome.witnessed is False
    assert ratchet.counter == 1, "exactly one counter spent"

    entries = client.queue.load_all()
    assert len(entries) == 1
    queued = entries[0]["body"]
    assert queued["component"]["counter"] == 0
    assert len(queued["mac"]) == 64
    # The queued bytes verify, unchanged, whenever they are finally sent.
    assert queued["mac"] == _mac_at(ik, 0, component_preimage(queued))


def test_deduplicated_is_read_out_rather_than_read_as_a_failure(rig, make_client):
    """The route answers 200 {deduplicated:true, witnessed:false} to a
    replayed event. That is a SUCCESS -- reading it as witnessed=False
    alone loses the difference between 'already recorded' and 'not
    recorded'."""
    client, opener = make_client(
        script=[
            (
                "ok",
                200,
                {
                    "deduplicated": True,
                    "witnessed": False,
                    "component": {"component_id": COMPONENT_ID, "counter": 4, "verified": True},
                    "note": "already recorded",
                },
            )
        ]
    )
    client.state.baseline_ref = BASELINE
    outcome = witness_flow.witness(
        client, kind="artifact", content_hash="8" * 64, mime="image/png",
        component=_envelope(counter=4), mac="0" * 64,
    )
    assert outcome.deduplicated is True
    assert outcome.witnessed is False
    assert outcome.component.verified is True
    assert outcome.component.counter == 4


def test_CONTROL_an_ordinary_success_is_not_marked_deduplicated(rig):
    client, server, opener, ratchet, ik = rig
    outcome = witness_flow.witness(
        client, kind="artifact", content_hash="a" * 64, mime="image/png",
        component=_envelope(), ratchet=ratchet,
    )
    assert outcome.deduplicated is False
