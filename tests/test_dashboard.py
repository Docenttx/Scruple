"""WO-B5. The dashboard, region by region, in every state it has.

THE SHAPE OF EVERY TEST IN THIS FILE, AND WHY.

The gate is "each region renders in each state" plus "a region is ABSENT
when its state does not apply". Those are one test, not two, and the
second half is the one that carries the weight: a panel that draws every
region unconditionally passes any suite that only ever asserts presence.
So the helpers here draw the WHOLE panel tree -- the parent panel and
every sub-panel whose `poll()` passes, exactly as Blender does it -- and
`assert_absent` checks the region's heading is nowhere in that tree.

`dashboard.HEADINGS` is the vocabulary. `test_no_heading_is_a_substring_
of_another` below is what makes `heading in text` a sound test: if two
headings overlapped, an absence assertion could pass or fail for the
wrong region.
"""

from __future__ import annotations

import importlib
import sys

import pytest

from tests.mocks import bpy_mock, v2


ADDON_MODULES = (
    "adapter.preferences",
    "operators.auth",
    "operators.dashboard",
    "operators.witness",
    "operators.verify",
    "operators.c2pa",
    "operators.chain_lock",
    "panels.dashboard",
    "panels.model",
    "panels.main",
)


@pytest.fixture
def with_bpy():
    bpy_mock.install()
    bpy_mock.reset()
    for name in ADDON_MODULES:
        if name in sys.modules:
            importlib.reload(sys.modules[name])
    yield sys.modules["bpy"]
    bpy_mock.reset()
    sys.modules.pop("bpy", None)
    for name in ADDON_MODULES:
        if name in sys.modules:
            importlib.reload(sys.modules[name])


@pytest.fixture
def signed_in(monkeypatch):
    from adapter import preferences as _prefs

    monkeypatch.setattr(_prefs, "is_authed", lambda: True)
    monkeypatch.setattr(_prefs, "get_base_url", lambda: "https://scruple.test")
    return True


@pytest.fixture
def clean_projects():
    """The project index is a module-level cache; a test that fetched a
    list must not leak it into the next one."""
    from adapter import projects as _projects

    _projects.reset()
    yield _projects
    _projects.reset()


# ---- drawing the whole panel, the way Blender does ---------------------

def draw_all():
    """Parent panel, then every sub-panel whose poll() passes, into one
    layout tree. This is the user's whole view of the addon."""
    import panels.main as pm

    layout = bpy_mock.Layout()
    ctx = bpy_mock.context_get()

    def _instance(cls):
        obj = cls()
        obj.layout = layout
        return obj

    pm.SCRUPLE_PT_main.draw(_instance(pm.SCRUPLE_PT_main), ctx)
    for cls in (
        pm.SCRUPLE_PT_projects,
        pm.SCRUPLE_PT_edits,
        pm.SCRUPLE_PT_tracker,
        pm.SCRUPLE_PT_receipt,
        pm.SCRUPLE_PT_locks,
    ):
        if cls.poll(ctx):
            cls.draw(_instance(cls), ctx)
    return layout


def text_of(layout) -> str:
    return " || ".join(layout.all_text())


def ops_of(layout):
    return layout.all_operators()


def assert_present(layout, region):
    from panels import dashboard as _dash

    heading = _dash.HEADINGS[region]
    assert heading in text_of(layout), f"region {region!r} ({heading!r}) should be drawn"


def assert_absent(layout, region):
    from panels import dashboard as _dash

    heading = _dash.HEADINGS[region]
    assert heading not in text_of(layout), f"region {region!r} ({heading!r}) must NOT be drawn"


# ---- the vocabulary itself ---------------------------------------------

def test_no_heading_is_a_substring_of_another():
    """What makes every `assert_absent` in this file sound. If one
    heading contained another, an absence assertion would be testing a
    different region than it names."""
    from panels import dashboard as _dash

    headings = [_dash.HEADINGS[r] for r in _dash.REGIONS]
    assert len(set(headings)) == len(headings)
    for a in headings:
        for b in headings:
            if a is not b:
                assert a not in b, f"{a!r} is a substring of {b!r}"


def test_every_region_has_a_heading_and_a_drawer():
    from panels import dashboard as _dash

    for region in _dash.REGIONS:
        assert region in _dash.HEADINGS
        assert hasattr(_dash, f"draw_{region}"), region


# ---- state 1: signed out ------------------------------------------------

def test_signed_out_draws_the_gate_and_NOTHING_else(with_bpy, fresh_state, clean_projects, monkeypatch):
    from adapter import preferences as _prefs
    from panels import dashboard as _dash

    monkeypatch.setattr(_prefs, "is_authed", lambda: False)
    layout = draw_all()

    assert_present(layout, _dash.SIGNIN)
    assert "scruple.sign_in" in ops_of(layout)
    # The control. Every other region describes a session that does not
    # exist, and a panel that drew them anyway would be describing
    # nothing at all.
    for region in (
        _dash.HEADER, _dash.PROJECTS, _dash.EDITS, _dash.TRACKER,
        _dash.RECEIPT, _dash.LOCKS, _dash.PAYMENT, _dash.QUEUE,
        _dash.RECONCILIATION, _dash.ERROR, _dash.CONNECTION,
    ):
        assert_absent(layout, region)


def test_signing_out_with_a_capture_in_the_tracker_draws_NO_receipt(
    with_bpy, fresh_state, clean_projects, monkeypatch
):
    """Found by the live in-Blender run, not by this suite.

    Blender evaluates a sub-panel's `poll()` independently of whether its
    parent drew anything, so `SCRUPLE_PT_main` returning early at the
    sign-in gate does NOT suppress its children. With a witnessed capture
    still in the tracker, the receipt sub-panel drew a leaf id under a
    signed-out panel. The earlier signed-out test could not catch it: it
    ran with an empty tracker.
    """
    from adapter import preferences as _prefs
    from adapter import state as _state
    from panels import dashboard as _dash

    monkeypatch.setattr(_prefs, "is_authed", lambda: False)
    _state.record_assurance(_witnessed("lf_1"))

    layout = draw_all()
    assert_present(layout, _dash.SIGNIN)
    assert_absent(layout, _dash.RECEIPT)
    assert "lf_1" not in text_of(layout)


def test_signed_in_draws_the_header_and_NOT_the_gate(with_bpy, fresh_state, clean_projects, signed_in):
    from panels import dashboard as _dash

    layout = draw_all()
    assert_present(layout, _dash.HEADER)
    assert_absent(layout, _dash.SIGNIN)


# ---- state 2: the connection indicator ---------------------------------

def test_a_session_that_never_asked_says_so_and_does_not_claim_connected(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """UNKNOWN is a third answer. The banner is for a fetch that was
    attempted and failed, so it must not fire here -- and the header must
    not say Connected either."""
    from panels import dashboard as _dash

    layout = draw_all()
    text = text_of(layout)
    assert "Not checked" in text
    assert "Connected" not in text
    assert_absent(layout, _dash.CONNECTION)


def test_an_unreachable_server_raises_the_banner(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from panels import dashboard as _dash
    from adapter import projects as _projects

    http_opener.offline = True
    _ops.refresh_projects()
    assert _projects.connection() == _projects.OFFLINE

    layout = draw_all()
    assert_present(layout, _dash.CONNECTION)
    assert "Captures are still recorded and spooled" in text_of(layout)
    assert "scruple.refresh_projects" in ops_of(layout)


def test_a_reachable_server_does_NOT_raise_the_banner(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    """The control for the test above."""
    from operators import dashboard as _ops
    from panels import dashboard as _dash
    from adapter import projects as _projects

    v2.register_projects(http_opener, [v2.project_row(1, "Teapot")])
    _ops.refresh_projects()
    assert _projects.connection() == _projects.ONLINE

    layout = draw_all()
    assert_absent(layout, _dash.CONNECTION)
    assert "Connected" in text_of(layout)


def test_a_refused_key_reads_as_unauthorized_not_as_offline(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from adapter import projects as _projects

    v2.register_projects(http_opener, [], status=401)
    _ops.refresh_projects()
    assert _projects.connection() == _projects.UNAUTHORIZED

    layout = draw_all()
    text = text_of(layout)
    assert "The key this addon holds was refused" in text
    assert "Offline" not in text


# ---- state 3: the project manager --------------------------------------

def test_the_project_list_renders_and_can_be_switched(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from panels import dashboard as _dash
    from adapter import state as _state

    api = v2.register_projects(
        http_opener,
        [v2.project_row(1, "Teapot", iteration_count=3), v2.project_row(2, "Suzanne")],
    )
    _ops.refresh_projects()

    layout = draw_all()
    assert_present(layout, _dash.PROJECTS)
    text = text_of(layout)
    assert "Teapot" in text and "Suzanne" in text
    assert "3 leaves" in text
    assert "scruple.select_project" in ops_of(layout)
    assert "2 tracked" in text

    # Switching is not cosmetic: it sets the id the witness body carries
    # AND tells the server.
    op = _ops.SCRUPLE_OT_select_project()
    op.project_id = 2
    assert op.execute(None) == {"FINISHED"}
    assert _state.get().active_project_id == 2
    assert _state.get().active_project_name == "Suzanne"
    assert ("set-active", 2) in api["calls"]


def test_a_locked_project_shows_its_lock_identity_and_an_unlocked_one_does_not(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    """WorkspaceView's Merkle card, reduced to the two values that
    identify a locked project. The control is the second half: an
    unlocked project has neither, and empty rows would be worse than no
    rows."""
    from operators import dashboard as _ops

    locked = v2.project_row(1, "Locked", status="chain_locked")
    locked["scr_id"] = "SCR_ABC123"
    locked["merkle_root"] = "f" * 64
    v2.register_projects(http_opener, [locked, v2.project_row(2, "Plain")])
    _ops.refresh_projects()

    op = _ops.SCRUPLE_OT_select_project()
    op.project_id = 1
    op.execute(None)
    text = text_of(draw_all())
    assert "SCR SCR_ABC123" in text
    assert "root ffffffffffffffffffffffff" in text
    assert "Anchored" in text

    op = _ops.SCRUPLE_OT_select_project()
    op.project_id = 2
    op.execute(None)
    text = text_of(draw_all())
    assert "SCR " not in text
    assert "root " not in text
    assert "Tracking" in text


def test_an_archived_project_is_listed_separately_and_can_be_restored(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from adapter import projects as _projects

    api = v2.register_projects(
        http_opener,
        [v2.project_row(1, "Teapot"), v2.project_row(2, "OldThing", is_archived=True)],
    )
    _ops.refresh_projects()
    assert [p.name for p in _projects.index().live] == ["Teapot"]
    assert [p.name for p in _projects.index().archived] == ["OldThing"]

    layout = draw_all()
    assert "Archived (1)" in text_of(layout)

    op = _ops.SCRUPLE_OT_archive_project()
    op.project_id = 2
    op.restore = True
    assert op.execute(None) == {"FINISHED"}
    assert ("restore", 2) in api["calls"]
    assert [p.name for p in _projects.index().live] == ["OldThing", "Teapot"] or \
        sorted(p.name for p in _projects.index().live) == ["OldThing", "Teapot"]


def test_the_edits_region_is_ABSENT_with_no_active_project_and_present_with_one(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from panels import dashboard as _dash

    v2.register_projects(
        http_opener,
        [v2.project_row(1, "Teapot", iteration_count=2)],
        iterations={1: [v2.iteration_row(1), v2.iteration_row(2, witnessed=False)]},
    )
    _ops.refresh_projects()

    # The control: nothing selected, so there is no project whose history
    # could be shown.
    assert_absent(draw_all(), _dash.EDITS)

    op = _ops.SCRUPLE_OT_select_project()
    op.project_id = 1
    op.execute(None)

    layout = draw_all()
    assert_present(layout, _dash.EDITS)
    text = text_of(layout)
    assert "#1" in text and "#2" in text
    # The server's own `witnessed` field, read as a field -- row 2 is not
    # witnessed and must not read as if it were.
    assert "[witnessed]" in text
    assert "[not witnessed]" in text


def test_a_selected_project_that_is_not_in_the_list_is_shown_as_an_id_not_invented(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from adapter import state as _state

    _state.get().active_project_id = 99
    text = text_of(draw_all())
    assert "project 99 (not in the fetched list)" in text


# ---- state 4: payment ---------------------------------------------------

def test_signed_in_with_no_payment_method_blocks_every_paid_button(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from panels import dashboard as _dash
    from adapter import state as _state

    http_opener.register("GET", "/api/stripe/config", {"prices": {"finalize": 1000}})
    _ops.refresh_payment_config()
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)

    layout = draw_all()
    assert_present(layout, _dash.PAYMENT)
    assert_present(layout, _dash.LOCKS)
    text = text_of(layout)
    assert "No payment method on file" in text
    # THE CONTROL. A blocked action draws no operator at all -- a greyed
    # button a user can still press teaches them to press it and read the
    # error afterwards.
    assert "scruple.c2pa_sign" not in ops_of(layout)
    assert "scruple.chain_lock" not in ops_of(layout)
    assert "scruple.setup_payment" in ops_of(layout)


def test_a_refused_payment_read_says_WHY_not_merely_that_it_was_not_read(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    """`/api/stripe/*` authenticates with a NextAuth session cookie, not
    a bearer key, so a plugin session gets a 401 by design. The panel has
    to say that: "not read yet" reads as something a Check now button
    could fix, and this one cannot be."""
    from operators import dashboard as _ops

    http_opener.register("GET", "/api/stripe/config", {"error": "Unauthorized"}, status=401)
    assert _ops.refresh_payment_config() is False

    text = text_of(draw_all())
    assert "Could not read payment settings: HTTP 401" in text
    assert "have not been read this session" not in text


def test_a_successful_payment_read_says_no_such_thing(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    """The control."""
    from operators import dashboard as _ops

    v2.register_stripe(http_opener)
    assert _ops.refresh_payment_config() is True

    text = text_of(draw_all())
    assert "Could not read payment settings" not in text
    assert "have not been read this session" not in text


def test_a_card_on_file_and_a_leaf_unblocks_the_buttons_with_their_prices(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from panels import dashboard as _dash
    from adapter import state as _state

    v2.register_stripe(http_opener)
    _ops.refresh_payment_config()
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)

    layout = draw_all()
    assert_absent(layout, _dash.PAYMENT)
    text = text_of(layout)
    assert "scruple.c2pa_sign" in ops_of(layout)
    assert "scruple.chain_lock" in ops_of(layout)
    # Prices come from /api/stripe/config, not from the SDK defaults --
    # $50.00 basic and $100.00 pinned are what that body says.
    assert "Local Lock  $10.00" in text
    assert "Chain-lock (basic)  $50.00" in text
    assert "Chain-lock (pinned)  $100.00" in text


def test_a_card_on_file_but_no_leaf_still_blocks_and_says_why(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    """Two different reasons a control is blocked, and they must not read
    the same: /api/v2/mark marks a leaf, so a card with nothing witnessed
    is still blocked."""
    from operators import dashboard as _ops

    v2.register_stripe(http_opener)
    _ops.refresh_payment_config()

    layout = draw_all()
    text = text_of(layout)
    assert "Nothing to mark yet" in text
    assert "scruple.c2pa_sign" not in ops_of(layout)


def test_checkpoint_is_blocked_for_a_reason_no_card_can_fix(
    with_bpy, fresh_state, clean_projects, signed_in, sdk_client, http_opener
):
    from operators import dashboard as _ops
    from adapter import state as _state

    v2.register_stripe(http_opener)
    _ops.refresh_payment_config()
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)

    layout = draw_all()
    text = text_of(layout)
    assert "No /api/v2 route for this" in text
    # It has never been a registered operator on this panel since WO-B3;
    # the dashboard must not resurrect it as a button.
    assert "scruple.checkpoint" not in ops_of(layout)


# ---- state 5: the lock dashboard ---------------------------------------

def _mark_outcome(**kw):
    from scruple_api.outcomes import MarkOutcome, Outstanding

    kw.setdefault("leaf_id", "lf_1")
    kw.setdefault("modalities_requested", [])
    kw.setdefault("modalities_applied", [])
    return MarkOutcome(**kw), Outstanding


def test_an_unmarked_leaf_says_so_rather_than_saying_nothing(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from adapter import state as _state

    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)
    assert "Not locked" in text_of(draw_all())


def test_a_clean_mark_shows_what_was_applied(with_bpy, fresh_state, clean_projects, signed_in):
    from adapter import locks as _locks
    from adapter import state as _state

    outcome, _ = _mark_outcome(modalities_requested=["chain"], modalities_applied=["chain"])
    outcome.local_lock["scr_id"] = "SCR_ABC123"
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)
    _state.record_mark(_locks.from_outcome(outcome))

    text = text_of(draw_all())
    assert "Applied: chain" in text
    assert "SCR_ABC123" in text
    assert "OUTSTANDING" not in text


def test_a_mark_with_outstanding_modalities_says_OUTSTANDING(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """§9.5. The control for the test above: what was paid for and NOT
    done has to be as visible as what was."""
    from adapter import locks as _locks
    from adapter import state as _state
    from scruple_api.outcomes import Outstanding

    outcome, _ = _mark_outcome(
        modalities_requested=["chain"],
        modalities_applied=[],
        outstanding=[Outstanding(modality="chain", reason="payment not verified")],
    )
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)
    _state.record_mark(_locks.from_outcome(outcome))

    text = text_of(draw_all())
    assert "OUTSTANDING — chain: payment not verified" in text


def test_a_queued_mark_does_not_read_as_applied(with_bpy, fresh_state, clean_projects, signed_in):
    from adapter import locks as _locks
    from adapter import state as _state

    outcome, _ = _mark_outcome(modalities_requested=["chain"], queued=True)
    _state.remember_leaf(leaf_id="lf_1", mime="image/png", content_hash="c" * 64)
    _state.record_mark(_locks.from_outcome(outcome))

    text = text_of(draw_all())
    assert "Lock queued" in text
    assert "Applied:" not in text


# ---- state 6: the tracker ----------------------------------------------

def _witnessed(leaf_id="lf_1", **kw):
    from adapter import assurance as _a

    return _a.LeafAssurance(
        state=_a.WITNESSED, kind="artifact", mime="image/png",
        leaf_id=leaf_id, content_hash="c" * 64, **kw
    )


def test_the_tracker_is_ABSENT_before_the_first_capture(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from panels import dashboard as _dash

    assert_absent(draw_all(), _dash.TRACKER)


def test_the_tracker_lists_every_capture_with_its_state(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from adapter import assurance as _a
    from adapter import state as _state
    from panels import dashboard as _dash

    _state.record_assurance(_witnessed("lf_1"))
    _state.record_assurance(_a.LeafAssurance(state=_a.QUEUED, kind="artifact", mime="image/png", content_hash="d" * 64))
    _state.record_assurance(_a.refused("no baseline", kind="render"))

    layout = draw_all()
    assert_present(layout, _dash.TRACKER)
    text = text_of(layout)
    assert "1 witnessed" in text and "1 queued" in text and "1 refused locally" in text
    assert "scruple.select_capture" in ops_of(layout)


# ---- state 7: the receipt drill-down, verified vs passthrough ----------

def _signed(surrogate: bool, attestation=None):
    from adapter import assurance as _a

    return _a.LeafAssurance(
        state=_a.WITNESSED, kind="artifact", mime="image/png",
        leaf_id="lf_1", content_hash="c" * 64,
        signature=_a.SignatureRecord(
            leaf_signature="MEYCIQ...",
            leaf_signer_key_id="ocid1.key...",
            leaf_signature_alg="ECDSA_SHA_256",
            signer_surrogate=surrogate,
            source=_a.FROM_RECEIPT,
        ),
        attestation_status=attestation,
        attestation_source=_a.FROM_RECEIPT,
    )


def test_the_drilldown_is_ABSENT_for_a_capture_with_no_leaf(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """A locally refused capture never reached the server, so there is no
    receipt to open. Its tracker row already carries the whole story."""
    from adapter import assurance as _a
    from adapter import state as _state
    from panels import dashboard as _dash

    _state.record_assurance(_a.refused("no baseline", kind="render"))
    assert_absent(draw_all(), _dash.RECEIPT)


def test_a_verified_leaf_reads_verified_and_NOT_passthrough(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from adapter import state as _state
    from panels import dashboard as _dash

    _state.record_assurance(_signed(surrogate=False, attestation="verified"))
    layout = draw_all()
    assert_present(layout, _dash.RECEIPT)
    text = text_of(layout)
    assert "Assurance tier: verified" in text
    assert "passthrough" not in text
    assert "SOFTWARE surrogate" not in text


def test_a_surrogate_signed_leaf_reads_passthrough_and_says_NOT_hardware_backed(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """The line the L2 floor exists for. The surrogate on :8799 reports
    protectionMode SOFTWARE truthfully, and a leaf it signed must never
    render as hardware-backed."""
    from adapter import state as _state

    _state.record_assurance(_signed(surrogate=True, attestation="passthrough"))
    text = text_of(draw_all())
    assert "Assurance tier: passthrough (software-signed)" in text
    assert "NOT hardware-backed" in text
    assert "Assurance tier: verified" not in text


def test_a_leaf_with_no_disclosed_signature_reads_undisclosed(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """Today's server. `undisclosed` is not `unsigned` -- the witness DID
    sign the leaf and the app tier drops the field."""
    from adapter import state as _state

    _state.record_assurance(_witnessed("lf_1"))
    text = text_of(draw_all())
    assert "Assurance tier: undisclosed" in text
    assert "No leaf signature was disclosed" in text
    assert "Assurance tier: verified" not in text
    assert "NOT hardware-backed" not in text


def test_the_verify_claim_is_attributed_never_asserted(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from dataclasses import replace
    from adapter import state as _state

    rec = replace(
        _witnessed("lf_1"),
        independently_verifiable_claimed=True,
        verification_basis_kind="asymmetric_leaf_signature",
    )
    _state.record_assurance(rec)
    text = text_of(draw_all())
    assert "scruple.ai says independently verifiable: yes" in text
    assert "This addon has not checked that" in text


def test_the_drilldown_follows_the_selection_not_the_newest(
    with_bpy, fresh_state, clean_projects, signed_in
):
    """The tracker is a deque new captures push onto the FRONT, so the
    drill-down addresses a capture by key. Select an older row, witness
    something else, and the drill-down must still show the old one."""
    from adapter import assurance as _a
    from adapter import state as _state
    from operators import dashboard as _ops

    _state.record_assurance(_witnessed("lf_old"))
    op = _ops.SCRUPLE_OT_select_capture()
    op.capture_key = _a.capture_key(_state.last_assurance())
    op.execute(None)

    _state.record_assurance(_witnessed("lf_new"))
    text = text_of(draw_all())
    assert "Receipt — leaf lf_old" in text
    assert "Receipt — leaf lf_new" not in text


# ---- state 8: the queue and the offline indicator ----------------------

def _spool_three(client, http_opener, tmp_path):
    from adapter import flow as _wf
    from tests.mocks import bpy_mock as bm

    http_opener.offline = True
    for i in range(3):
        path = tmp_path / f"frame{i}.png"
        path.write_bytes(b"pixels-%d" % i)
        scene = bm.Scene()
        scene.render.filepath = str(path)
        _wf.witness_render(client, scene)
    http_opener.offline = False


def test_a_spooled_queue_is_shown(
    with_bpy, signed_in, clean_projects, attached_client, http_opener, tmp_path
):
    from panels import dashboard as _dash

    _spool_three(attached_client, http_opener, tmp_path)
    layout = draw_all()
    assert_present(layout, _dash.QUEUE)
    assert "3 capture(s) queued offline" in text_of(layout)
    assert "scruple.drain_queue" in ops_of(layout)


def test_an_empty_queue_shows_NOTHING(
    with_bpy, signed_in, clean_projects, attached_client, http_opener, tmp_path
):
    """The control. This is the same assertion WO-B4 made against the old
    panel; it is repeated here because WO-B5 rebuilt the panel and a
    region that survived a rewrite is not the same as one that was
    re-tested after it."""
    from adapter import flow as _wf
    from panels import dashboard as _dash
    from tests.mocks import bpy_mock as bm

    path = tmp_path / "ok.png"
    path.write_bytes(b"pixels")
    scene = bm.Scene()
    scene.render.filepath = str(path)
    _wf.witness_render(attached_client, scene)

    assert_absent(draw_all(), _dash.QUEUE)


# ---- state 9: the error surface ----------------------------------------

def test_an_error_is_surfaced_and_can_be_dismissed(
    with_bpy, fresh_state, clean_projects, signed_in
):
    from adapter import state as _state
    from operators import dashboard as _ops
    from panels import dashboard as _dash

    _state.set_error("the server said no")
    layout = draw_all()
    assert_present(layout, _dash.ERROR)
    assert "the server said no" in text_of(layout)
    assert "scruple.clear_error" in ops_of(layout)

    assert _ops.SCRUPLE_OT_clear_error().execute(None) == {"FINISHED"}
    # The control: dismissed means gone, not greyed.
    assert_absent(draw_all(), _dash.ERROR)


# ---- the switch actually routes a leaf ---------------------------------

def test_switching_project_changes_where_the_next_leaf_is_witnessed(
    with_bpy, signed_in, clean_projects, attached_client, http_opener, tmp_path
):
    """The point of a project switcher. A selection that did not appear
    on the witness body would be a decoration."""
    from adapter import flow as _wf
    from operators import dashboard as _ops
    from tests.mocks import bpy_mock as bm

    v2.register_projects(
        http_opener, [v2.project_row(1, "Teapot"), v2.project_row(2, "Suzanne")]
    )
    _ops.refresh_projects()
    op = _ops.SCRUPLE_OT_select_project()
    op.project_id = 2
    op.execute(None)

    path = tmp_path / "shot.png"
    path.write_bytes(b"pixels")
    scene = bm.Scene()
    scene.render.filepath = str(path)
    _wf.witness_render(attached_client, scene)

    witness_calls = [r for r in http_opener.recorded if r.path == "/api/v2/witness"]
    assert witness_calls, "nothing was witnessed"
    assert witness_calls[-1].body["project_id"] == 2


def test_no_project_selected_sends_no_project_id(
    with_bpy, signed_in, clean_projects, attached_client, http_opener, tmp_path
):
    """The control. The server resolves or creates a per-tenant project
    when `project_id` is absent (v2/witness/route.ts:376), so sending 0
    or a stale id would be worse than sending nothing."""
    from adapter import flow as _wf
    from tests.mocks import bpy_mock as bm

    path = tmp_path / "shot.png"
    path.write_bytes(b"pixels")
    scene = bm.Scene()
    scene.render.filepath = str(path)
    _wf.witness_render(attached_client, scene)

    witness_calls = [r for r in http_opener.recorded if r.path == "/api/v2/witness"]
    assert "project_id" not in witness_calls[-1].body


# ---- draw() opens no sockets -------------------------------------------

def test_drawing_the_whole_panel_makes_NO_network_call(
    with_bpy, signed_in, clean_projects, attached_client, http_opener, tmp_path
):
    """Blender calls draw() on every redraw -- a mouse move over the
    viewport. One HTTP round-trip in there is one per frame, on the main
    thread. The mock records every attempt, including ones that fail, so
    this counts attempts and not successes."""
    from adapter import flow as _wf
    from operators import dashboard as _ops
    from tests.mocks import bpy_mock as bm

    v2.register_projects(http_opener, [v2.project_row(1, "Teapot")])
    v2.register_stripe(http_opener)
    _ops.refresh_projects()
    _ops.refresh_payment_config()
    path = tmp_path / "shot.png"
    path.write_bytes(b"pixels")
    scene = bm.Scene()
    scene.render.filepath = str(path)
    _wf.witness_render(attached_client, scene)

    before = len(http_opener.recorded)
    for _ in range(5):
        draw_all()
    assert len(http_opener.recorded) == before, [
        r.path for r in http_opener.recorded[before:]
    ]
