"""One read of everything the dashboard shows, built once per draw.

WO-B5. The old panel read `_state`, `_prefs`, `_assurance` and
`_payment` inline in `draw()`, and decided what a region meant while it
was drawing it. That made two things impossible: testing "is this region
shown in this state" without a bpy layout, and being sure the same
question got the same answer in two regions.

So the panel is split in three:

  * this module builds a `DashboardModel` -- a snapshot, with every
    derived question already answered as a field;
  * `panels/dashboard.py` turns a model into layout calls, and contains
    no policy;
  * `panels/main.py` registers the bpy classes.

WHAT THIS MODULE MUST NOT DO. It opens no sockets. `build()` runs on
every redraw -- a mouse move over the 3D viewport -- so a fetch here
would be an HTTP round-trip per frame on Blender's main thread. The
project list, the payment config and the receipts are all read from
caches that operators and the drain timer fill; `projects.index()` and
`state.payment_config()` are cached-only by construction, and the one
thing that does touch the disk is `queue.count()`, which reads a single
small JSON file (noted, not hidden -- if it ever shows up in a profile,
the fix is a cache in the SDK's QueueStore, not a second copy here).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from adapter import assurance as _assurance
from adapter import locks as _locks
from adapter import preferences as _prefs
from adapter import projects as _projects
from adapter import scene as _scene
from adapter import sdk as _sdk
from adapter import state as _state


#: How many project rows the sidebar shows before it stops. The Fusion
#: palette caps its own viewport at ten rows (FusionPalette.tsx:546) and
#: scrolls beyond; a bpy N-panel does not scroll a sub-list, so the cap
#: is a hard one and the remainder is stated as a count.
MAX_PROJECT_ROWS = 10

#: How many tracker rows are drawn. The tracker itself keeps 50
#: (state.MAX_ASSURANCES); the panel is a sidebar.
MAX_TRACKER_ROWS = 8

#: How many of the active project's server-side iterations are listed.
MAX_EDIT_ROWS = 6


@dataclass(frozen=True)
class DashboardModel:
    # -- session
    signed_in: bool = False
    base_url: str = ""
    sdk_commit: Optional[str] = None
    #: The .blend currently open, or None before the first save.
    document_name: Optional[str] = None

    # -- connection (adapter/projects.py's five states)
    connection: str = _projects.UNKNOWN
    connection_label: str = ""
    connection_checked: bool = False
    connection_error: Optional[str] = None

    # -- projects
    projects: List[Any] = field(default_factory=list)
    archived_projects: List[Any] = field(default_factory=list)
    project_overflow: int = 0
    active_project: Optional[Any] = None
    active_project_id: Optional[int] = None
    active_project_name: Optional[str] = None
    active_project_status: Optional[str] = None
    #: True when an id is selected but the fetched list has no row for it
    #: -- the panel prints the id and does not invent a name.
    active_project_unresolved: bool = False
    edits: List[Dict[str, Any]] = field(default_factory=list)
    edit_overflow: int = 0
    detail_error: Optional[str] = None

    # -- tracker
    captures: List[Any] = field(default_factory=list)
    capture_overflow: int = 0
    capture_counts: Dict[str, int] = field(default_factory=dict)
    selected_capture: Optional[Any] = None
    selected_capture_key: Optional[str] = None

    # -- queue / settlement
    queue_depth: int = 0
    reconciliation: Optional[Any] = None

    # -- payment and locks
    payment_summary: Optional[str] = None
    payment_ready: bool = False
    payment_checked: bool = False
    payment_error: Optional[str] = None
    lock_actions: List[Any] = field(default_factory=list)
    last_leaf_id: Optional[str] = None
    lock_record: Optional[Any] = None
    lock_state_line: str = _locks.NOT_MARKED

    # -- errors
    last_error: Optional[str] = None

    # ---- questions the regions ask ------------------------------------
    # Each of these is exactly one region's poll. They are properties
    # rather than fields so there is no way for a stored flag to drift
    # from the data it was computed from.

    @property
    def show_signin(self) -> bool:
        return not self.signed_in

    @property
    def show_projects(self) -> bool:
        return self.signed_in

    @property
    def show_offline(self) -> bool:
        """The offline indicator. NOT drawn on UNKNOWN: never having
        asked is not evidence of being offline."""
        return self.connection in (_projects.OFFLINE, _projects.UNAUTHORIZED, _projects.ERROR)

    @property
    def show_queue(self) -> bool:
        return self.queue_depth > 0

    @property
    def show_tracker(self) -> bool:
        return self.signed_in and bool(self.captures)

    @property
    def show_receipt(self) -> bool:
        """The drill-down. Two conditions, and the first one was missing
        until the live run caught it: a sub-panel's `poll()` is evaluated
        by Blender INDEPENDENTLY of whether its parent drew anything, so
        `SCRUPLE_PT_main` returning early at the sign-in gate does not
        suppress the children. Signing out with a capture still in the
        tracker drew a receipt under a signed-out panel.

        The second: only for a capture that reached the server. A locally
        refused capture has no receipt to drill into, and its tracker row
        already carries the whole story.
        """
        if not self.signed_in:
            return False
        rec = self.selected_capture
        return bool(rec is not None and getattr(rec, "leaf_id", None))

    @property
    def show_locks(self) -> bool:
        return self.signed_in

    @property
    def show_payment_setup(self) -> bool:
        return self.signed_in and not self.payment_ready

    @property
    def show_reconciliation(self) -> bool:
        rec = self.reconciliation
        return rec is not None and not rec.all_clear

    @property
    def show_error(self) -> bool:
        return bool(self.last_error)


def build() -> DashboardModel:
    """Read every source once. No network, no disk beyond the queue file."""
    st = _state.get()
    signed_in = _prefs.is_authed()
    idx = _projects.index()
    det = _projects.detail()

    live = list(idx.live)
    archived = list(idx.archived)

    active = _projects.active_project()
    active_id = st.active_project_id

    edits: List[Dict[str, Any]] = []
    detail_error = None
    if det is not None and det.project_id == active_id:
        # Newest first, matching the Fusion palette's reversed list.
        edits = list(reversed(det.iterations))
        detail_error = det.error

    captures = _state.assurances()
    selected = _state.selected_capture()
    last_leaf_id = st.last_leaf_id
    lock_record = _state.mark_for(last_leaf_id)

    config = _state.payment_config()
    payment_ready = _state.payment_ready()

    return DashboardModel(
        signed_in=signed_in,
        base_url=_prefs.get_base_url() if signed_in else "",
        sdk_commit=(_sdk.vendored_sdk_info().get("source_commit") or None),
        document_name=_scene.document_name(),
        connection=idx.connection,
        connection_label=_projects.connection_label(idx.connection),
        connection_checked=idx.checked,
        connection_error=idx.error,
        projects=live[:MAX_PROJECT_ROWS],
        archived_projects=archived[:MAX_PROJECT_ROWS],
        project_overflow=max(0, len(live) - MAX_PROJECT_ROWS),
        active_project=active,
        active_project_id=active_id,
        active_project_name=st.active_project_name,
        active_project_status=st.active_project_status,
        active_project_unresolved=bool(active_id is not None and active is None),
        edits=edits[:MAX_EDIT_ROWS],
        edit_overflow=max(0, len(edits) - MAX_EDIT_ROWS),
        detail_error=detail_error,
        captures=captures[:MAX_TRACKER_ROWS],
        capture_overflow=max(0, len(captures) - MAX_TRACKER_ROWS),
        capture_counts=_state.state_counts(),
        selected_capture=selected,
        selected_capture_key=(_assurance.capture_key(selected) if selected is not None else None),
        queue_depth=_state.queue_depth(),
        reconciliation=_state.last_reconciliation(),
        payment_summary=st.payment_method_summary,
        payment_ready=payment_ready,
        payment_checked=config is not None,
        payment_error=st.payment_error,
        lock_actions=_locks.actions(
            signed_in=signed_in,
            payment_ready=payment_ready,
            has_leaf=bool(last_leaf_id),
            config=config,
        ),
        last_leaf_id=last_leaf_id,
        lock_record=lock_record,
        lock_state_line=_locks.state_line(lock_record),
        last_error=st.last_error,
    )
