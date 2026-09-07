"""The project manager: listing, switching, and the server-side history.

WO-B5. The Fusion palette is a project manager first -- a sidebar of
projects with a leaf count and a last-touched time, a selection that
follows the server's active project, an archived section, and a
per-project list of witnessed edits. The Blender panel had none of it:
`BlenderState.active_project_id` existed and nothing ever set it, so
every leaf this addon has ever produced went to whatever project
`/api/v2/witness` auto-created for the tenant.

WHICH ROUTE THIS USES, AND WHY IT IS A v1 ONE.

`gap.json` endpoints rows 1-3 record `/api/projects`, `/api/projects/{id}`
and project creation as `no_equivalent`: the /api/v2 surface has nine
routes and not one of them lists projects. But `/api/v2/witness` DOES
take an optional `project_id` (app/api/v2/witness/route.ts:115), and
resolves or creates a per-tenant project when it is absent
(route.ts:376-399). So the leaf surface is project-aware while the
project surface is v1-only.

That leaves two options and only one of them is a project manager:

  a. do not list projects, and let every capture land in the tenant's
     auto-created `scruple:workflow` bucket. This is what the addon did
     before this WO. It is not "v2-pure" -- it is a dashboard with the
     manager removed.
  b. read the project list from `/api/projects`, which authenticates
     with the same bearer key (`requireUser`, app/api/projects/route.ts:4),
     and write the chosen id into the v2 leaf.

This is (b), and it is written down rather than hidden: every function
here names its route, and `docs/canon/blender-l2/05-DASHBOARD.md`
carries it as an open item for the server, not for the addon. The
alternative would be a project switcher whose selection changed nothing,
which is worse than no switcher.

NOTHING HERE IS CALLED FROM `draw()`. Blender calls a panel's draw on
every redraw -- a mouse move over the viewport -- so a fetch there is a
network round-trip per frame on the main thread. The panel reads
`index()` and `detail()`, which return the last cached answer and never
open a socket; `refresh()` is called from an operator (a button press),
from sign-in, and from the drain timer's worker thread.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import log as _log
from . import state as _state

from scruple_host_sdk import http as _http


# ---- connection state ---------------------------------------------------
# Five, not two, for the same reason assurance.py has five states rather
# than a boolean: "we have not asked" and "we asked and it worked" are
# different answers and a panel that renders both as a green dot is
# lying about one of them.

#: No fetch has been attempted in this session. NOT "offline" and not
#: "connected" -- unknown.
UNKNOWN = "unknown"
ONLINE = "online"
#: A transport failure: DNS, refused connection, timeout. The server was
#: not reached at all.
OFFLINE = "offline"
#: Reached, and it refused the key (401/403).
UNAUTHORIZED = "unauthorized"
#: Reached, and answered something else that is not a project list.
ERROR = "error"

CONNECTION_STATES = (UNKNOWN, ONLINE, OFFLINE, UNAUTHORIZED, ERROR)

_CONNECTION_LABEL = {
    UNKNOWN: "Not checked",
    ONLINE: "Connected",
    OFFLINE: "Offline",
    UNAUTHORIZED: "Sign in",
    ERROR: "Server error",
}


def connection_label(state: str) -> str:
    return _CONNECTION_LABEL.get(state, state)


#: Icons are a Blender concern, but the mapping belongs beside the states
#: so a new state cannot be added without deciding how it reads.
_CONNECTION_ICON = {
    UNKNOWN: "QUESTION",
    ONLINE: "CHECKMARK",
    OFFLINE: "UNLINKED",
    UNAUTHORIZED: "ERROR",
    ERROR: "ERROR",
}


def connection_icon(state: str) -> str:
    return _CONNECTION_ICON.get(state, "QUESTION")


# ---- the project row ----------------------------------------------------

#: `projects.status`, in the words the Fusion palette uses for it
#: (FusionPalette.tsx:160-169). Same vocabulary in both hosts on purpose:
#: a user who has seen one should not have to learn the other.
_STATUS_LABEL = {
    "unlocked": "Tracking",
    "checkpointed": "Checkpoint",
    "local_locked": "Locked",
    "chain_locked": "Anchored",
    "persistent_locked": "Persistent",
    "permanent_locked": "Permanent",
}


def status_label(status: Optional[str]) -> str:
    if not status:
        return "Tracking"
    return _STATUS_LABEL.get(status, status)


@dataclass(frozen=True)
class Project:
    id: int
    name: str
    type: str = "image"
    status: str = "unlocked"
    iteration_count: int = 0
    witnessed_count: int = 0
    is_archived: bool = False
    is_active: bool = False
    scr_id: Optional[str] = None
    merkle_root: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @property
    def status_label(self) -> str:
        return status_label(self.status)

    @property
    def locked(self) -> bool:
        return self.status not in ("unlocked", "checkpointed")


def _project_from_row(row: Dict[str, Any]) -> Optional[Project]:
    try:
        pid = int(row["id"])
    except (KeyError, TypeError, ValueError):
        return None
    return Project(
        id=pid,
        name=str(row.get("name") or f"project {pid}"),
        type=str(row.get("type") or "image"),
        status=str(row.get("status") or "unlocked"),
        iteration_count=int(row.get("iteration_count") or 0),
        witnessed_count=int(row.get("witnessed_count") or 0),
        is_archived=bool(row.get("is_archived")),
        is_active=bool(row.get("is_active")),
        scr_id=row.get("scr_id"),
        merkle_root=row.get("merkle_root"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


# ---- the cached index ---------------------------------------------------

@dataclass
class ProjectIndex:
    """The last answer `/api/projects` gave, and when.

    `connection` is a property of THIS fetch, not a running guess: a
    successful list makes it ONLINE, a refused connection makes it
    OFFLINE, and never having asked leaves it UNKNOWN. Nothing else sets
    it, so a green indicator on this panel always has one specific
    successful HTTP response behind it.
    """

    live: List[Project] = field(default_factory=list)
    archived: List[Project] = field(default_factory=list)
    server_active_id: Optional[int] = None
    connection: str = UNKNOWN
    error: Optional[str] = None
    fetched_at: Optional[float] = None

    @property
    def checked(self) -> bool:
        return self.fetched_at is not None

    def find(self, project_id: Optional[int]) -> Optional[Project]:
        if project_id is None:
            return None
        for p in list(self.live) + list(self.archived):
            if p.id == project_id:
                return p
        return None


@dataclass
class ProjectDetail:
    """`GET /api/projects/{id}` -- the row plus its iterations, which is
    the server's own history of the project and NOT this session's
    tracker. The two are deliberately separate surfaces: the tracker
    shows what this Blender session attempted (refusals included, which
    the server never hears about), and this shows what is on the record.
    """

    project_id: int
    project: Optional[Project] = None
    iterations: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    fetched_at: Optional[float] = None

    @property
    def witnessed_count(self) -> int:
        return sum(1 for it in self.iterations if it.get("witnessed"))


_INDEX = ProjectIndex()
_DETAIL: Optional[ProjectDetail] = None


def index() -> ProjectIndex:
    """The cached list. Never fetches -- safe to call from draw()."""
    return _INDEX


def detail() -> Optional[ProjectDetail]:
    """The cached detail for whichever project was last fetched, or None.
    Never fetches."""
    return _DETAIL


def reset() -> None:
    global _INDEX, _DETAIL
    _INDEX = ProjectIndex()
    _DETAIL = None


def connection() -> str:
    return _INDEX.connection


# ---- fetching -----------------------------------------------------------

def _classify(result) -> str:
    if result.ok:
        return ONLINE
    if result.status is None:
        return OFFLINE
    if result.status in (401, 403):
        return UNAUTHORIZED
    return ERROR


def refresh(client, *, limit: int = 200, include_archived: bool = True) -> ProjectIndex:
    """GET /api/projects. One call for live, one for archived.

    `queue_kind` is deliberately not passed to `http.submit` -- a project
    list is a query, and there is nothing to replay if it fails (see
    scruple_host_sdk/http.py's header). A failed list is reported as a
    connection state, not spooled.
    """
    global _INDEX

    if client is None:
        _INDEX = ProjectIndex(connection=UNAUTHORIZED, error="Not signed in.", fetched_at=time.time())
        return _INDEX

    live_result = _http.submit(client, "GET", "/api/projects", query={"limit": limit, "archived": "live"})
    conn = _classify(live_result)
    if not live_result.ok:
        _INDEX = ProjectIndex(
            connection=conn,
            error=live_result.error or "Could not list projects.",
            fetched_at=time.time(),
        )
        _log.warn(f"projects: list failed ({conn}) -- {_INDEX.error}")
        return _INDEX

    body = live_result.body if isinstance(live_result.body, dict) else {}
    live = [p for p in (_project_from_row(r) for r in body.get("projects") or []) if p is not None]

    archived: List[Project] = []
    if include_archived:
        arch_result = _http.submit(
            client, "GET", "/api/projects", query={"limit": limit, "archived": "only"}
        )
        if arch_result.ok and isinstance(arch_result.body, dict):
            archived = [
                p for p in (_project_from_row(r) for r in arch_result.body.get("projects") or [])
                if p is not None
            ]

    server_active = body.get("activeId")
    _INDEX = ProjectIndex(
        live=live,
        archived=archived,
        server_active_id=int(server_active) if isinstance(server_active, int) else None,
        connection=ONLINE,
        error=None,
        fetched_at=time.time(),
    )
    _adopt_active(client)
    _log.info(f"projects: {len(live)} live, {len(archived)} archived, activeId={_INDEX.server_active_id}")
    return _INDEX


def _adopt_active(client) -> None:
    """Follow the server's active project when this session has not
    chosen one, and refresh the name/status of the one it has.

    The Fusion palette always follows `activeId` (FusionPalette.tsx:371-378),
    because in Fusion the server's active project IS whatever document
    the add-in has open. Blender has no such binding -- an explicit
    switch in this panel is a user's decision -- so the server only wins
    when the user has not decided.
    """
    st = _state.get()
    if st.active_project_id is None and _INDEX.server_active_id is not None:
        _apply(_INDEX.find(_INDEX.server_active_id))
        return
    current = _INDEX.find(st.active_project_id)
    if current is not None:
        _apply(current)


def _apply(project: Optional[Project]) -> None:
    st = _state.get()
    if project is None:
        st.active_project_id = None
        st.active_project_name = None
        st.active_project_status = None
        return
    st.active_project_id = project.id
    st.active_project_name = project.name
    st.active_project_status = project.status


def active_project() -> Optional[Project]:
    """The Project row for whatever `state.active_project_id` names, if
    the cached index has it. None when nothing is selected OR when the
    list has not been fetched -- a selected id with no row behind it is
    rendered as the id, not invented."""
    return _INDEX.find(_state.get().active_project_id)


def select(client, project_id: Optional[int], *, tell_server: bool = True) -> bool:
    """Switch the active project.

    Local first, then the server: the switch must take effect for the
    next capture even if `set-active` cannot be reached, because the
    thing that actually routes a leaf is `project_id` on the witness body
    (adapter/flow.py:365), not the server's `is_active` flag. Telling the
    server is how the web UI and any other host see the same choice.
    """
    if project_id is None:
        _apply(None)
        return True

    project = _INDEX.find(project_id)
    if project is None:
        _state.set_error(f"Project {project_id} is not in the fetched list; refresh and try again.")
        return False
    _apply(project)
    global _DETAIL
    _DETAIL = None

    if tell_server and client is not None:
        result = _http.submit(client, "POST", f"/api/projects/{project_id}/set-active")
        if not result.ok:
            # Not a failure of the switch. Said out loud rather than
            # swallowed, because the web UI will disagree with the panel
            # until the next successful call.
            _state.set_error(
                f"Switched to '{project.name}' locally; scruple.ai was not told "
                f"({result.error or 'no reason given'})."
            )
    return True


def refresh_detail(client, project_id: Optional[int] = None) -> Optional[ProjectDetail]:
    """GET /api/projects/{id}: the row and its iterations."""
    global _DETAIL

    pid = project_id if project_id is not None else _state.get().active_project_id
    if pid is None:
        _DETAIL = None
        return None
    if client is None:
        _DETAIL = ProjectDetail(project_id=pid, error="Not signed in.", fetched_at=time.time())
        return _DETAIL

    result = _http.submit(client, "GET", f"/api/projects/{pid}")
    if not result.ok or not isinstance(result.body, dict):
        _DETAIL = ProjectDetail(
            project_id=pid,
            error=result.error or "Could not read the project.",
            fetched_at=time.time(),
        )
        return _DETAIL

    body = result.body
    row = body.get("project") if isinstance(body.get("project"), dict) else None
    iterations = [it for it in (body.get("iterations") or []) if isinstance(it, dict)]
    _DETAIL = ProjectDetail(
        project_id=pid,
        project=_project_from_row(row) if row else None,
        iterations=iterations,
        fetched_at=time.time(),
    )
    return _DETAIL


def set_archived(client, project_id: int, archived: bool) -> bool:
    """POST/DELETE /api/projects/{id}/archive. Returns whether the server
    accepted it; the caller refreshes."""
    if client is None:
        return False
    method = "POST" if archived else "DELETE"
    result = _http.submit(client, method, f"/api/projects/{project_id}/archive")
    if not result.ok:
        _state.set_error(f"Could not {'archive' if archived else 'restore'} project {project_id}: {result.error}")
        return False
    if archived and _state.get().active_project_id == project_id:
        # An archived project must not stay selected: the next capture
        # would be routed into it silently.
        _apply(None)
    return True
