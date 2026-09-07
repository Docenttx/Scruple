"""WO-B4 -- store-and-forward, and gap detection.

The gate this file is written against:

    stop the server, capture three events, restart it, and show all three
    land. Then deliberately drop one from the queue and show the
    reconciliation reports the gap. A reconciliation that reports "all
    clear" on the dropped case fails this WO.

EVERY MUST-FIRE CHECK HERE IS PAIRED WITH A MUST-NOT-FIRE ONE, in the same
file and usually in the adjacent function, because a settlement that
reports a gap for everything is as useless as one that reports none:

    the three drained captures settle          <-> the dropped one is a gap
    a gap makes all_clear False                <-> a clean run makes it True
    an unreachable server is not "all clear"   <-> and is not a gap either
    a refused capture is reported              <-> and is NOT counted a gap
    the panel draws the queue box when spooled <-> and NOT when the queue is empty

`http_opener.offline` is a transport failure (`URLError`), which is what a
refused connection actually looks like to `http.submit()` -- not a 500. The
distinction matters: `submit()` queues both, but a 4xx neither queues nor
retries, and one of the tests below is about exactly that.
"""

from __future__ import annotations

import json

import pytest

from adapter import flow as _wf
from adapter import handlers as _handlers
from adapter import ledger as _ledger
from adapter import reconcile as _reconcile
from adapter import state as _state
from tests.mocks import bpy_mock, http_mock, v2


def _render(tmp_path, name, data):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / name)
    (tmp_path / name).write_bytes(data)
    return scene


def _capture_three_offline(client, opener, tmp_path):
    """Three renders taken while nothing can reach the server."""
    opener.offline = True
    outcomes = []
    for i in range(3):
        scene = _render(tmp_path, f"frame{i}.png", f"pixels-{i}".encode())
        outcomes.append(_wf.witness_render(client, scene, trigger="render_complete"))
    opener.offline = False
    return outcomes


# ---- the ledger is written before the request ---------------------------

def test_a_ledger_line_exists_for_a_capture_that_never_reached_the_server(
    attached_client, http_opener, tmp_path
):
    """The property the whole settlement rests on. If the ledger were
    written from the RESPONSE, an undelivered capture would leave no trace
    and there would be nothing to reconcile against."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    led = _ledger.get(attached_client)
    lines = led.load_all()
    assert len(lines) == 3
    assert [l["state"] for l in lines] == ["queued", "queued", "queued"]
    # And each one carries the hash of the bytes on disk, computed before
    # anything was sent -- which is what makes it checkable later.
    import hashlib
    assert lines[0]["content_hash"] == hashlib.sha256(b"pixels-0").hexdigest()
    assert all(l["queue_id"] for l in lines)


def test_the_ledger_survives_the_process_that_wrote_it(attached_client, http_opener, tmp_path):
    """It is a file, not a list. A second LedgerStore over the same path
    -- which is what the next Blender session builds -- sees every line."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    path = _ledger.get(attached_client).path
    reopened = _ledger.LedgerStore(path)
    assert reopened.count() == 3


def test_seq_is_monotonic_across_reopens(attached_client, http_opener, tmp_path):
    _capture_three_offline(attached_client, http_opener, tmp_path)
    path = _ledger.get(attached_client).path
    assert [l["seq"] for l in _ledger.LedgerStore(path).load_all()] == [1, 2, 3]
    assert _ledger.LedgerStore(path).next_seq() == 4


# ---- THE GATE, first half: three captures survive the outage ------------

def test_three_captures_taken_offline_are_spooled_on_disk(attached_client, http_opener, tmp_path):
    outcomes = _capture_three_offline(attached_client, http_opener, tmp_path)
    assert all(o.queued for o in outcomes)
    assert all(o.witnessed is False for o in outcomes)
    assert attached_client.queue_depth == 3
    # And nothing has been witnessed: the server saw no witness POST at all.
    assert [r for r in http_opener.recorded if r.path == "/api/v2/witness" and r.method == "POST"]
    assert not any(o.leaf_id for o in outcomes)


def test_all_three_land_when_the_server_comes_back(attached_client, http_opener, tmp_path):
    """The must-fire half of the gate. Also the must-NOT-fire control for
    the dropped-entry test below: on a clean drain the settlement reports
    NO gap and all_clear is True."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client)

    assert rec.drain.attempted == 3
    assert rec.drain.succeeded == 3
    assert rec.drain.remaining == 0
    assert attached_client.queue_depth == 0

    assert rec.counts.get(_reconcile.SETTLED) == 3
    assert rec.gaps == []
    assert rec.inconclusive == []
    assert rec.all_clear is True
    # Settled means the SERVER said so, per capture -- three verify calls.
    verifies = [r for r in http_opener.recorded if r.path.startswith("/api/v2/verify/")]
    assert len(verifies) == 3
    # And each settled line now carries the leaf id the server reported.
    assert all(l.leaf_id for l in rec.lines if l.disposition == _reconcile.SETTLED)


def test_the_tracker_stops_saying_queued_once_the_captures_land(
    attached_client, http_opener, tmp_path
):
    from adapter import assurance as _assurance

    _capture_three_offline(attached_client, http_opener, tmp_path)
    assert {r.state for r in _state.assurances()} == {_assurance.QUEUED}
    _reconcile.reconcile(attached_client)
    assert {r.state for r in _state.assurances()} == {_assurance.WITNESSED}


# ---- THE GATE, second half: a dropped entry is a GAP --------------------

def _undeclarable_render(client, tmp_path):
    """A render in a format adapter/scene.py has no MIME row for. Refused
    HERE, before anything is sent -- property 1 forbids guessing a type."""
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "weird")
    scene.render.image_settings.file_format = "SOMETHING_ELSE"
    # `candidate_render_outputs` appends the extension Blender would; the
    # file has to be at the path the addon will actually look at, or the
    # capture is skipped for "no file" rather than refused for the MIME.
    from adapter import scene as _scene
    for cand in _scene.candidate_render_outputs(scene):
        open(cand, "wb").write(b"x")
        break
    return _wf.witness_render(client, scene)


def _drop_one_queue_entry(client, index):
    entries = client.queue.load_all()
    dropped = entries.pop(index)
    client.queue.replace_all(entries)
    return dropped


def test_a_queue_entry_dropped_before_the_drain_is_reported_as_a_gap(
    attached_client, http_opener, tmp_path
):
    """THE control the WO names: 'A reconciliation that reports all clear
    on the dropped case fails this WO.'"""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    dropped = _drop_one_queue_entry(attached_client, 1)

    rec = _reconcile.reconcile(attached_client)

    assert rec.all_clear is False
    assert len(rec.gaps) == 1
    gap = rec.gaps[0]
    assert gap.content_hash == dropped["body"]["content_hash"]
    assert gap.disposition == _reconcile.GAP
    assert "MISSING" in gap.sentence
    # The other two are fine -- a settlement that condemned everything
    # would satisfy the assertion above and be useless.
    assert rec.counts.get(_reconcile.SETTLED) == 2


def test_the_LAST_capture_being_dropped_is_also_a_gap(attached_client, http_opener, tmp_path):
    """The case a server-side counter ratchet cannot see on its own.

    H-4's per-component accounting notices a gap when a LATER counter
    arrives -- counter 3 landing without 2 opens a gap for 2. Nothing
    later ever arrives for a trailing loss, so from the server it is
    indistinguishable from a component that simply stopped, and only the
    heartbeat window says anything at all. The client ledger has the
    intent recorded either way, which is why the two halves are
    complementary rather than redundant.
    """
    _capture_three_offline(attached_client, http_opener, tmp_path)
    dropped = _drop_one_queue_entry(attached_client, 2)
    rec = _reconcile.reconcile(attached_client)
    assert [g.content_hash for g in rec.gaps] == [dropped["body"]["content_hash"]]
    assert rec.all_clear is False


def test_a_gap_names_the_capture_a_human_can_look_for(attached_client, http_opener, tmp_path):
    _capture_three_offline(attached_client, http_opener, tmp_path)
    _drop_one_queue_entry(attached_client, 0)
    rec = _reconcile.reconcile(attached_client)
    [gap] = rec.gaps
    assert gap.filename == "frame0.png"
    assert gap.seq == 1
    assert gap.kind == "render"


# ---- the settlement must never guess ------------------------------------

def _witness_three_online(client, opener, tmp_path):
    for i in range(3):
        scene = _render(tmp_path, f"live{i}.png", f"live-pixels-{i}".encode())
        _wf.witness_render(client, scene, trigger="render_complete")


def test_a_settlement_that_cannot_reach_the_server_is_not_all_clear(
    attached_client, http_opener, tmp_path
):
    """Three captures that DID land, then a settlement run with the server
    unreachable. Nothing is queued, so there is nothing to be outstanding
    -- every line is a question that could not be asked."""
    _witness_three_online(attached_client, http_opener, tmp_path)
    http_opener.offline = True
    rec = _reconcile.reconcile(attached_client)
    assert rec.all_clear is False
    assert rec.counts.get(_reconcile.UNCHECKED) == 3


def test_a_settlement_that_cannot_reach_the_server_reports_NO_gaps(
    attached_client, http_opener, tmp_path
):
    """The must-NOT-fire twin of the test above. 'Could not ask' is not
    'absent'. A settlement that condemned every capture whenever the
    network was down would make the gap signal worthless."""
    _witness_three_online(attached_client, http_opener, tmp_path)
    http_opener.offline = True
    rec = _reconcile.reconcile(attached_client)
    assert rec.gaps == []
    assert all(l.disposition == _reconcile.UNCHECKED for l in rec.lines)


def test_a_settlement_run_online_over_the_same_captures_IS_all_clear(
    attached_client, http_opener, tmp_path
):
    """And the twin of the twin: the same three captures, the same
    settlement, with the server reachable. If this did not pass, the two
    tests above would be proving only that the harness is broken."""
    _witness_three_online(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client)
    assert rec.all_clear is True
    assert rec.counts.get(_reconcile.SETTLED) == 3


def test_a_capture_still_in_the_queue_is_outstanding_and_not_a_gap(
    attached_client, http_opener, tmp_path
):
    """Nothing has failed here -- it has not finished. Reporting it as
    missing would cry wolf on every offline session."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client, drain_first=False)
    assert rec.counts.get(_reconcile.OUTSTANDING) == 3
    assert rec.gaps == []
    assert rec.all_clear is False  # still not clear: nothing is on the record


# ---- accounted-for losses are reported, and are not gaps ----------------

def test_a_locally_refused_capture_is_on_the_ledger(attached_client, http_opener, tmp_path):
    """Vendor floor item 5: a session that refused four captures must not
    read as a quiet afternoon."""
    _undeclarable_render(attached_client, tmp_path)
    lines = _ledger.get(attached_client).load_all()
    assert [l["state"] for l in lines] == [_ledger.REFUSED_LOCALLY]
    assert lines[0]["error"]


def test_a_locally_refused_capture_is_NOT_counted_as_a_gap(attached_client, http_opener, tmp_path):
    _undeclarable_render(attached_client, tmp_path)
    rec = _reconcile.reconcile(attached_client)
    assert rec.gaps == []
    assert rec.counts.get(_reconcile.REFUSED_LOCALLY) == 1


def test_a_server_rejection_is_reported_and_is_not_retried(attached_client, http_opener, tmp_path):
    """A 4xx is neither queued nor retried (http.py). The ledger records
    it as rejected and the settlement reports it as a known loss with a
    reason -- distinct from a gap, which is a loss with no explanation."""
    def _refuse(_body):
        raise v2.Rejected(400, {"error": {"code": "invalid_body", "message": "no"}})

    http_opener.register("POST", "/api/v2/witness", _refuse)
    scene = _render(tmp_path, "shot.png", b"bytes")
    outcome = _wf.witness_render(attached_client, scene)
    assert outcome.queued is False
    assert attached_client.queue_depth == 0

    rec = _reconcile.reconcile(attached_client)
    assert rec.counts.get(_reconcile.REJECTED) == 1
    assert rec.gaps == []
    assert rec.all_clear is True  # accounted for: the server said why


# ---- a leaf that stops being on the record ------------------------------

def test_settlement_downgrades_a_capture_the_server_turns_out_not_to_have(
    attached_client, http_opener, tmp_path
):
    """The direction that keeps a tracker from being more flattering than
    the record: this addon said 'witnessed' because the server did, and a
    later settlement finds the hash is not there."""
    from adapter import assurance as _assurance

    scene = _render(tmp_path, "ok.png", b"bytes")
    outcome = _wf.witness_render(attached_client, scene)
    assert outcome.witnessed is True
    assert _state.assurances()[0].state == _assurance.WITNESSED

    # The server forgets it: re-register /verify as a route that finds
    # nothing, exactly as the real route answers for an unknown hash.
    http_opener.register_prefix(
        "GET", "/api/v2/verify/", lambda _b, path="": {"found": False, "witnessed": False}
    )
    rec = _reconcile.reconcile(attached_client)
    assert len(rec.gaps) == 1
    assert rec.all_clear is False
    assert _state.assurances()[0].state == _assurance.DELIVERED_NOT_WITNESSED


# ---- the ledger's own integrity is part of the settlement ---------------

def test_a_ledger_row_deleted_from_the_middle_is_reported(attached_client, http_opener, tmp_path):
    _capture_three_offline(attached_client, http_opener, tmp_path)
    led = _ledger.get(attached_client)
    entries = led.load_all()
    led.replace_all([entries[0], entries[2]])          # seq 2 removed
    rec = _reconcile.reconcile(attached_client)
    assert rec.missing_ledger_seq == [2]
    assert rec.all_clear is False


def test_an_unparseable_ledger_line_is_counted_not_swallowed(
    attached_client, http_opener, tmp_path
):
    _capture_three_offline(attached_client, http_opener, tmp_path)
    led = _ledger.get(attached_client)
    with open(led.path, "a", encoding="utf-8") as f:
        f.write("{not json at all\n")
    rec = _reconcile.reconcile(attached_client)
    assert rec.damaged_ledger_lines == 1
    assert rec.all_clear is False


def test_a_clean_ledger_reports_no_damage_and_no_missing_rows(
    attached_client, http_opener, tmp_path
):
    """Must-NOT-fire twin of the two above."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client)
    assert rec.damaged_ledger_lines == 0
    assert rec.missing_ledger_seq == []


# ---- the drain is the SDK's, and does not duplicate ----------------------

def test_a_failing_drain_does_not_enqueue_a_second_copy(attached_client, http_opener, tmp_path):
    """queue.drain()'s docstring: an entry already IN the queue must not be
    re-enqueued on repeated failure. Three captures, a drain that cannot
    reach anything, and the depth must still be three -- not six."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    http_opener.offline = True
    result = _reconcile.drain(attached_client)
    assert result.succeeded == 0
    assert attached_client.queue_depth == 3
    assert result.remaining == 3


def test_drain_records_which_entries_left_the_queue(attached_client, http_opener, tmp_path):
    _capture_three_offline(attached_client, http_opener, tmp_path)
    before = [str(e["id"]) for e in attached_client.queue.load_all()]
    result = _reconcile.drain(attached_client)
    assert sorted(result.ids_left) == sorted(before)
    assert result.ids_after == []


# ---- honesty about what this addon cannot ask ---------------------------

def test_component_accounting_is_reported_as_unavailable_with_a_reason(
    attached_client, http_opener, tmp_path
):
    """H-4's server-side gap detection exists and this addon cannot reach
    it. The settlement says so rather than omitting the field, because an
    absent key reads as 'nothing to report'."""
    _capture_three_offline(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client)
    assert rec.component["available"] is False
    assert rec.component["reason"] == "not_configured"
    assert "component envelope" in rec.component["detail"]


def test_component_accounting_with_an_id_is_reported_as_unwired(attached_client, tmp_path):
    """WO-B7 renamed this reason. `no_sdk_route` said the SDK had no way to
    ask; the vendored SDK's `server_library.component_status()` does, and
    WO-B7 drove it against the scratch app. What is true is that this
    adapter does not call it -- so the payload says `not_wired`, and does
    not blame an API that is no longer the obstacle."""
    status = _reconcile.component_status(attached_client, "some-component-id")
    assert status["available"] is False
    assert status["reason"] == "not_wired"
    assert "unwired" in status["detail"]


def test_no_session_means_no_settlement_not_a_clean_one(fresh_state):
    assert _handlers.settle() is None


# ---- the timer -----------------------------------------------------------

def test_register_installs_a_drain_timer(bpy_installed, fresh_state):
    from tests.conftest import reload_addon_modules

    reload_addon_modules(["adapter.handlers"])
    from adapter import handlers as h

    h.register()
    try:
        assert bpy_installed.app.timers.is_registered(h._drain_tick)
        assert bpy_installed.app.timers.persistent[h._drain_tick] is True
    finally:
        h.unregister()


def test_unregister_removes_the_drain_timer(bpy_installed, fresh_state):
    from tests.conftest import reload_addon_modules

    reload_addon_modules(["adapter.handlers"])
    from adapter import handlers as h

    h.register()
    h.unregister()
    assert not bpy_installed.app.timers.is_registered(h._drain_tick)


def test_the_timer_tick_never_raises_and_always_reschedules(bpy_installed, fresh_state):
    """A bpy timer callback that raises is unregistered by Blender, so one
    network hiccup would silently stop every future drain."""
    from tests.conftest import reload_addon_modules

    reload_addon_modules(["adapter.handlers"])
    from adapter import handlers as h

    class _Exploding:
        @property
        def queue_depth(self):
            raise RuntimeError("boom")

    from adapter import sdk as _sdk

    _sdk.set_client(_Exploding())
    try:
        assert h._drain_tick() == h.DRAIN_INTERVAL_SECONDS
    finally:
        _sdk.reset_client()


# ---- the panel surfaces it, and only when there is something to say -----

def _draw_panel(client):
    from tests.mocks import bpy_mock as bm
    import panels.main as panel_main

    layout = bm.Layout()

    class _Panel:
        pass

    p = _Panel()
    p.layout = layout
    p._button_label = lambda base, action: base
    panel_main.SCRUPLE_PT_main.draw(p, bm.context_get())
    return layout


def test_the_panel_shows_the_queue_when_captures_are_spooled(
    bpy_installed, attached_client, http_opener, tmp_path, monkeypatch
):
    import panels.main as panel_main
    from adapter import preferences as _prefs

    monkeypatch.setattr(_prefs, "is_authed", lambda: True)
    _capture_three_offline(attached_client, http_opener, tmp_path)
    text = " ".join(_draw_panel(attached_client).all_text())
    assert "3 capture(s) queued offline" in text
    assert "scruple.drain_queue" in text


def test_the_panel_does_NOT_show_a_queue_box_when_nothing_is_spooled(
    bpy_installed, attached_client, http_opener, tmp_path, monkeypatch
):
    """The must-NOT-fire control: a panel that always draws every region
    proves nothing by drawing one."""
    import panels.main as panel_main
    from adapter import preferences as _prefs

    monkeypatch.setattr(_prefs, "is_authed", lambda: True)
    scene = _render(tmp_path, "ok.png", b"bytes")
    _wf.witness_render(attached_client, scene)
    text = " ".join(_draw_panel(attached_client).all_text())
    assert "queued offline" not in text
    assert "scruple.drain_queue" not in text


def test_the_panel_shows_a_gap_when_settlement_found_one(
    bpy_installed, attached_client, http_opener, tmp_path, monkeypatch
):
    from adapter import preferences as _prefs

    monkeypatch.setattr(_prefs, "is_authed", lambda: True)
    _capture_three_offline(attached_client, http_opener, tmp_path)
    _drop_one_queue_entry(attached_client, 1)
    _reconcile.reconcile(attached_client)
    text = " ".join(_draw_panel(attached_client).all_text())
    assert "Reconciliation" in text
    assert "MISSING #2" in text


def test_the_panel_does_NOT_show_a_reconciliation_box_when_all_is_clear(
    bpy_installed, attached_client, http_opener, tmp_path, monkeypatch
):
    from adapter import preferences as _prefs

    monkeypatch.setattr(_prefs, "is_authed", lambda: True)
    _capture_three_offline(attached_client, http_opener, tmp_path)
    rec = _reconcile.reconcile(attached_client)
    assert rec.all_clear is True
    text = " ".join(_draw_panel(attached_client).all_text())
    assert "MISSING" not in text
    assert "Reconciliation" not in text


# ---- the offline COLD start: a baseline this client already had ---------
#
# Measured before it was fixed: a Blender started while the server is
# unreachable refused every capture and spooled none of them, because
# attach() is a network call and witness() refuses without a baseline
# (D-3). See adapter/baseline_cache.py's header for the probe transcript.


def _cold_client(tmp_path, opener, name="cold"):
    from adapter import sdk as _sdk

    return _sdk.new_client(
        base_url="https://scruple.test",
        api_key="sk_test_xyz",
        opener=opener,
        cache_dir=str(tmp_path / name),
    )


def test_a_cold_session_offline_with_no_cached_baseline_captures_nothing(
    http_opener, tmp_path, fresh_state
):
    """The must-NOT-fire control for the whole cache: with no cache there
    is still no baseline, and the refusal is unchanged. A fix that made an
    offline session witness regardless would be inventing a baseline."""
    from adapter import sdk as _sdk

    v2.register_v2(http_opener)
    client = _cold_client(tmp_path, http_opener)
    _sdk.set_client(client)
    http_opener.offline = True
    scene = _render(tmp_path, "cold.png", b"cold-pixels")
    outcome = _wf.witness_render(client, scene)
    assert outcome.witnessed is False
    assert outcome.queued is False
    assert client.queue_depth == 0
    # And it is on the ledger as a refusal, not absent.
    assert [l["state"] for l in _ledger.get(client).load_all()] == [_ledger.REFUSED_LOCALLY]


def test_a_cold_session_offline_WITH_a_cached_baseline_spools_the_capture(
    http_opener, tmp_path, fresh_state
):
    """The must-fire twin: the same second session, after a first session
    that reached the server, spools instead of refusing."""
    from adapter import sdk as _sdk

    v2.register_v2(http_opener)
    first = _cold_client(tmp_path, http_opener)
    _sdk.set_client(first)
    assert _wf.ensure_attached(first) is True          # live attach, cache written

    second = _cold_client(tmp_path, http_opener)        # same cache dir = same profile
    _sdk.set_client(second)
    http_opener.offline = True
    scene = _render(tmp_path, "cold.png", b"cold-pixels")
    outcome = _wf.witness_render(second, scene)
    assert outcome.queued is True
    assert second.queue_depth == 1
    assert second.state.baseline_ref == first.state.baseline_ref


def test_a_cached_baseline_is_refused_when_the_build_has_changed(
    http_opener, tmp_path, fresh_state, monkeypatch
):
    """Rule 2. Different bytes are a different integration; a baseline
    describes code, and reusing one across a change would attach these
    leaves to a description of different code."""
    from adapter import baseline_cache as _bc
    from adapter import sdk as _sdk

    v2.register_v2(http_opener)
    first = _cold_client(tmp_path, http_opener)
    _sdk.set_client(first)
    assert _wf.ensure_attached(first) is True

    entry = _bc.load(first)
    assert entry is not None
    assert _bc.restore_if_same_build(first, "a different tamper surface hash") is None
    assert _bc.restore_if_same_build(first, entry.tamper_surface_hash) is not None


def test_nothing_is_cached_after_an_attach_that_failed(http_opener, tmp_path, fresh_state):
    """Rule 1: the cache holds baselines the SERVER stated, never ones this
    client got by any other route."""
    from adapter import baseline_cache as _bc
    from adapter import sdk as _sdk

    v2.register_v2(http_opener)
    client = _cold_client(tmp_path, http_opener)
    _sdk.set_client(client)
    http_opener.offline = True
    assert _wf.ensure_attached(client) is False
    assert _bc.load(client) is None


def test_a_capture_spooled_offline_lands_when_a_later_session_reconnects(
    http_opener, tmp_path, fresh_state
):
    """End to end across three Client lifetimes, which is what a Blender
    restart is: attach online, capture offline in a NEW client, settle in
    a THIRD. The queue and the ledger are files, so they are the only
    things that carry across."""
    from adapter import sdk as _sdk

    v2.register_v2(http_opener)
    first = _cold_client(tmp_path, http_opener)
    _sdk.set_client(first)
    _wf.ensure_attached(first)

    second = _cold_client(tmp_path, http_opener)
    _sdk.set_client(second)
    http_opener.offline = True
    for i in range(3):
        _wf.witness_render(second, _render(tmp_path, f"off{i}.png", f"off-{i}".encode()))
    assert second.queue_depth == 3

    http_opener.offline = False
    third = _cold_client(tmp_path, http_opener)
    _sdk.set_client(third)
    rec = _reconcile.reconcile(third)
    assert rec.drain.succeeded == 3
    assert rec.counts.get(_reconcile.SETTLED) == 3
    assert rec.all_clear is True


# ---- the rebaseline reason is a closed enum too -------------------------


def test_an_unmapped_rebaseline_reason_is_refused_before_any_request(
    attached_client, http_opener
):
    """Measured against the scratch app: reason='integration_update' ->
    invalid_enum_value. `Client.rebaseline()` validates nothing, so this
    is refused here -- the same treatment WO-B3 gave the `kind` enum."""
    before = len(http_opener.recorded)
    with pytest.raises(_wf.UnknownRebaselineReason):
        _wf.rebaseline(attached_client, reason="integration_update")
    assert len(http_opener.recorded) == before


def test_a_mapped_rebaseline_reason_goes_through(attached_client, http_opener):
    """Must-NOT-fire twin: the guard refuses one value and passes another."""
    result = _wf.rebaseline(attached_client, reason="capture_point_change", detail="x")
    assert result.baseline_ref
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/baseline/rebaseline"][-1]
    assert posted.body["reason"] == "capture_point_change"
