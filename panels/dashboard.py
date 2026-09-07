"""The regions. One function per region, no policy in any of them.

WO-B5. Every function here takes a `DashboardModel` and a `UILayout`,
draws one region, and returns whether it drew anything. Two rules make
the WO's gate testable:

  1. **A region decides nothing.** Whether it is shown is a `show_*`
     property on the model; the function checks that one property and
     returns False. So "is the queue box shown when the queue is empty"
     is a question about `model.show_queue`, and it is answered the same
     way in a test and on screen.

  2. **Every region opens with its heading, and the headings are
     unique.** `HEADINGS` below is the vocabulary a test asserts on. A
     region that is absent leaves no heading behind, which is what makes
     an ABSENCE assertion mean something -- the control the WO asks for
     is a panel that CANNOT pass by drawing everything.

The one piece of formatting policy that is here rather than in the model
is how an assurance tier is worded, and it is here because it is shared:
`assurance_line()` and the drill-down have to say the same thing about
the same leaf, and the earlier WO's tests already pin these two
functions by name.
"""

from __future__ import annotations

from adapter import assurance as _assurance
from adapter import locks as _locks
from adapter import projects as _projects


# ---- region ids and their headings --------------------------------------

SIGNIN = "signin"
HEADER = "header"
CONNECTION = "connection"
PROJECTS = "projects"
EDITS = "edits"
TRACKER = "tracker"
RECEIPT = "receipt"
LOCKS = "locks"
PAYMENT = "payment"
QUEUE = "queue"
RECONCILIATION = "reconciliation"
ERROR = "error"

REGIONS = (
    SIGNIN, HEADER, CONNECTION, PROJECTS, EDITS, TRACKER,
    RECEIPT, LOCKS, PAYMENT, QUEUE, RECONCILIATION, ERROR,
)

#: The heading each region draws first. Unique strings, and none is a
#: substring of another, so `heading in text` is an exact test.
HEADINGS = {
    SIGNIN: "Not signed in",
    HEADER: "Scruple for Blender",
    CONNECTION: "Cannot reach scruple.ai",
    PROJECTS: "Projects",
    EDITS: "Witnessed edits",
    TRACKER: "Captures this session",
    RECEIPT: "Receipt",
    LOCKS: "Lock & mint",
    PAYMENT: "Payment setup",
    QUEUE: "queued offline",
    RECONCILIATION: "Reconciliation",
    ERROR: "Last error",
}


# ---- shared wording -----------------------------------------------------

def assurance_line(rec) -> str:
    """One tracker row: what state the capture is in and what its
    evidence actually amounts to.

    WO-B3. The old row could say "witnessed" and nothing else, so a leaf
    nobody can verify and a leaf signed in an HSM rendered identically.
    The tier here is `LeafAssurance.assurance_tier`, which is
    `undisclosed` on every leaf today because the server sends no
    signature field -- and `undisclosed` is the honest word for that.
    """
    label = (rec.leaf_id or rec.content_hash or rec.filename or "-")[:16]
    if rec.state == _assurance.WITNESSED:
        return f"{label}  [witnessed · {rec.assurance_tier}]"
    return f"{label}  [{rec.state.replace('_', ' ')}]"


def receipt_line(r: dict) -> str:
    """One receipt row, with its state said out loud. `witnessed` is a
    field on the row because it is a field in the server's response
    (D-8); it is not inferred from the leaf id being present."""
    label = (r.get("leaf_id") or r.get("content_hash") or "-")[:16]
    if r.get("queued"):
        state = "queued"
    elif r.get("witnessed"):
        state = "witnessed"
    else:
        state = "not witnessed"
    return f"{label}  [{state}]"


def project_line(p) -> str:
    """One project row. Leaf count and status, because those are the two
    things that differ between two projects with similar names."""
    return f"{p.name}  ·  {p.iteration_count} leaves  ·  {p.status_label}"


def edit_line(it: dict) -> str:
    """One server-side iteration. `witnessed` is read as a field, never
    inferred from the leaf hash being present -- the same rule
    `receipt_line` follows, for the same reason."""
    seq = it.get("run_sequence")
    leaf = (it.get("leaf_hash") or it.get("output_hash") or "-")[:16]
    mark = "witnessed" if it.get("witnessed") else "not witnessed"
    return f"#{seq}  {leaf}  [{mark}]"


# ---- the regions --------------------------------------------------------

def draw_signin(layout, m) -> bool:
    if not m.show_signin:
        return False
    box = layout.box()
    box.label(text=HEADINGS[SIGNIN], icon="ERROR")
    box.label(text="Sign in once. Scruple stays live in Blender after that.")
    box.operator("scruple.sign_in", text="Sign in", icon="URL")
    return True


def draw_header(layout, m) -> bool:
    """Product identity, the document, the connection state, and the SDK
    build. The Fusion palette's top bar, in a row of labels."""
    box = layout.box()
    box.label(text=HEADINGS[HEADER], icon="SHADERFX")

    row = box.row()
    row.label(
        text=f"scruple.ai: {m.connection_label}",
        icon=_projects.connection_icon(m.connection),
    )
    if not m.connection_checked:
        # UNKNOWN is not "offline" and not "connected". Said in words,
        # with the button that would settle it.
        box.label(text="The project list has not been fetched this session.")
        box.operator("scruple.refresh_projects", text="Check now", icon="FILE_REFRESH")

    box.label(text=f"Blend file: {m.document_name or '(unsaved)'}")
    if m.sdk_commit:
        box.label(text=f"SDK {m.sdk_commit[:12]}")
    return True


def draw_connection(layout, m) -> bool:
    """The offline / unreachable banner. Drawn only when a fetch was
    ATTEMPTED and failed -- never on UNKNOWN, because not having asked is
    not evidence of anything."""
    if not m.show_offline:
        return False
    box = layout.box()
    box.label(text=HEADINGS[CONNECTION], icon="UNLINKED")
    box.label(text=f"{m.connection_label}. {m.connection_error or ''}".strip())
    if m.connection == _projects.UNAUTHORIZED:
        box.label(text="The key this addon holds was refused. Sign in again.")
        box.operator("scruple.sign_in", text="Sign in", icon="URL")
    box.label(text="Captures are still recorded and spooled; nothing is lost.")
    box.operator("scruple.refresh_projects", text="Retry", icon="FILE_REFRESH")
    return True


def draw_projects(layout, m) -> bool:
    if not m.show_projects:
        return False
    box = layout.box()
    box.label(text=HEADINGS[PROJECTS], icon="OUTLINER_COLLECTION")

    header = box.row()
    if m.connection_checked and m.connection == _projects.ONLINE:
        header.label(text=f"{len(m.projects) + m.project_overflow} tracked")
    else:
        header.label(text="not fetched")
    header.operator("scruple.refresh_projects", text="", icon="FILE_REFRESH")

    # The active project, first and named, because it is the one every
    # capture from now on will be routed into.
    if m.active_project is not None:
        row = box.row()
        row.label(text=f"Active: {project_line(m.active_project)}", icon="CHECKMARK")
        row.operator(
            "scruple.open_receipt", text="", icon="URL"
        ).project_id = m.active_project.id
        # The lock identity, when the project has one. WorkspaceView's
        # Merkle card, reduced to the two values that identify a locked
        # project: the SCR id a receipt is looked up by and the root the
        # lock committed to. Drawn only when the server sent them --
        # an unlocked project has neither and must not show empty rows.
        if m.active_project.scr_id:
            box.label(text=f"SCR {m.active_project.scr_id}")
        if m.active_project.merkle_root:
            box.label(text=f"root {m.active_project.merkle_root[:24]}…")
    elif m.active_project_unresolved:
        box.label(
            text=f"Active: project {m.active_project_id} (not in the fetched list)",
            icon="QUESTION",
        )
    else:
        box.label(
            text="No project selected — captures go to this tenant's default project.",
            icon="INFO",
        )

    if not m.projects:
        if m.connection_checked:
            box.label(text="No projects on this account yet.")
        return True

    for p in m.projects:
        row = box.row()
        op = row.operator(
            "scruple.select_project",
            text=project_line(p),
            icon="RADIOBUT_ON" if p.id == m.active_project_id else "RADIOBUT_OFF",
        )
        op.project_id = p.id
        arch = row.operator("scruple.archive_project", text="", icon="TRASH")
        arch.project_id = p.id
        arch.restore = False

    if m.project_overflow:
        box.label(text=f"+{m.project_overflow} more — open scruple.ai to see them all")

    if m.archived_projects:
        box.label(text=f"Archived ({len(m.archived_projects)})")
        for p in m.archived_projects:
            row = box.row()
            row.label(text=project_line(p))
            op = row.operator("scruple.archive_project", text="", icon="LOOP_BACK")
            op.project_id = p.id
            op.restore = True
    return True


def draw_edits(layout, m) -> bool:
    """The active project's history AS THE SERVER HOLDS IT.

    Deliberately a different region from the tracker. The tracker is what
    this Blender session attempted, refusals included -- the server never
    hears about those. This is what is on the record, and the two
    disagreeing is information, not a bug to be smoothed over by merging
    them into one list.
    """
    if not m.show_projects or m.active_project_id is None:
        return False
    box = layout.box()
    box.label(text=HEADINGS[EDITS], icon="TEXT")
    if m.detail_error:
        box.label(text=f"Could not read the project: {m.detail_error}", icon="ERROR")
        box.operator("scruple.refresh_projects", text="Retry", icon="FILE_REFRESH")
        return True
    if not m.edits:
        box.label(text="Not fetched, or no leaves on this project yet.")
        box.operator("scruple.refresh_projects", text="Fetch", icon="FILE_REFRESH")
        return True
    for it in m.edits:
        box.row().label(text=edit_line(it))
    if m.edit_overflow:
        box.label(text=f"+{m.edit_overflow} older")
    return True


def draw_tracker(layout, m) -> bool:
    if not m.show_tracker:
        return False
    box = layout.box()
    counts = "  ".join(
        f"{n} {k.replace('_', ' ')}" for k, n in sorted(m.capture_counts.items())
    )
    box.label(text=f"{HEADINGS[TRACKER]} — {counts}", icon="TEXT")
    for rec in m.captures:
        row = box.row()
        selected = _assurance.capture_key(rec) == m.selected_capture_key
        op = row.operator(
            "scruple.select_capture",
            text=assurance_line(rec),
            icon="DISCLOSURE_TRI_DOWN" if selected else "DISCLOSURE_TRI_RIGHT",
        )
        op.capture_key = _assurance.capture_key(rec)
    if m.capture_overflow:
        box.label(text=f"+{m.capture_overflow} earlier this session")
    return True


def draw_receipt(layout, m) -> bool:
    """The drill-down: everything this client actually knows about one
    leaf, in the words the evidence supports.

    Nothing in here is computed from an absence. `assurance_tier` is
    `undisclosed` when the server discloses no signature, the surrogate
    warning fires only on a flag the SERVER sent, and the /verify claim
    is attributed to scruple.ai rather than asserted.
    """
    if not m.show_receipt:
        return False
    rec = m.selected_capture
    box = layout.box()
    box.label(text=f"{HEADINGS[RECEIPT]} — leaf {rec.leaf_id}", icon="CHECKMARK")
    box.label(text=_assurance.sentence_for(rec.state))
    box.label(text=f"Assurance tier: {rec.assurance_tier}")

    if rec.signature.signer_surrogate:
        # The one line the L2 floor exists for. A software surrogate
        # signed it; that is not hardware-backed and the panel says the
        # words rather than showing a green tick.
        box.label(
            text="Signed by a SOFTWARE surrogate key — NOT hardware-backed.",
            icon="ERROR",
        )
    box.label(text=rec.signature.explanation)

    if rec.attestation_status:
        box.label(text=f"Attestation: {rec.attestation_status}")
    else:
        box.label(text="Attestation: none supplied by this client.")

    if rec.independently_verifiable_claimed is not None:
        claim = "yes" if rec.independently_verifiable_claimed else "no"
        box.label(text=f"scruple.ai says independently verifiable: {claim}")
        box.label(text=f"Basis: {rec.verification_basis_kind or 'not stated'}")
        box.label(text="This addon has not checked that and holds no key with which to.")

    if rec.canonicalization.agrees is None:
        box.label(
            text=f"Canonicalization: client {rec.canonicalization.client}; server profile not disclosed."
        )
    elif not rec.canonicalization.agrees:
        box.label(
            text=(
                f"Canonicalization MISMATCH: client {rec.canonicalization.client}, "
                f"server {rec.canonicalization.server}."
            ),
            icon="ERROR",
        )
    else:
        box.label(text=f"Canonicalization: {rec.canonicalization.client}, agreed.")

    if rec.content_hash:
        box.label(text=f"content {rec.content_hash[:24]}")
    box.operator("scruple.verify_last", text="Fetch receipt & verify", icon="CHECKMARK")
    return True


def draw_locks(layout, m) -> bool:
    if not m.show_locks:
        return False
    box = layout.box()
    box.label(text=HEADINGS[LOCKS], icon="FUND")

    if m.last_leaf_id:
        box.label(text=f"Leaf {m.last_leaf_id}: {m.lock_state_line}")
    else:
        box.label(text=_locks.NOT_MARKED)

    for action in m.lock_actions:
        if action.available and action.operator:
            op = box.operator(action.operator, text=action.button_text)
            if action.tier is not None:
                op.tier = action.tier
        else:
            # No operator at all. A greyed-out button a user can still
            # press teaches them to press it and read the error; a
            # sentence where the button would be is the honest version,
            # and it makes the absence testable.
            box.label(text=f"{action.label} {action.price} — {action.blocked_sentence}")
    return True


def draw_payment(layout, m) -> bool:
    if not m.show_payment_setup:
        return False
    box = layout.box()
    box.label(text=HEADINGS[PAYMENT], icon="ERROR")
    box.label(text="No payment method on file. Paid actions are blocked.")
    if m.payment_error:
        # Why, not just that. A bearer-key session gets a 401 from
        # /api/stripe/config by design (see operators/dashboard.py), and
        # "not read yet" would read as something a Check now button could
        # fix.
        box.label(text=f"Could not read payment settings: {m.payment_error}", icon="ERROR")
    elif not m.payment_checked:
        box.label(text="Payment settings have not been read this session.")
    box.operator("scruple.refresh_config", text="Check now", icon="FILE_REFRESH")
    box.label(text="Blender never sees your card. Payment lives on scruple.ai.")
    box.operator("scruple.setup_payment", text="Set up payment on scruple.ai", icon="URL")
    return True


def draw_queue(layout, m) -> bool:
    if not m.show_queue:
        return False
    box = layout.box()
    box.label(text=f"{m.queue_depth} capture(s) {HEADINGS[QUEUE]}", icon="SORTTIME")
    box.label(text="Spooled on disk. Retried automatically; nothing is on the record yet.")
    box.operator("scruple.drain_queue", text="Retry now", icon="FILE_REFRESH")
    return True


def draw_reconciliation(layout, m) -> bool:
    """Only when something is WRONG. A green "all clear" badge sitting on
    a panel is how a settlement stops being read; the honest default for
    a settled session is silence, and the operator's report is where
    "clear" gets said."""
    if not m.show_reconciliation:
        return False
    rec = m.reconciliation
    box = layout.box()
    box.label(text=HEADINGS[RECONCILIATION], icon="ERROR")
    box.label(text=rec.summary[:200])
    for line in rec.gaps[:5]:
        box.row().label(
            text=f"MISSING #{line.seq} {(line.filename or line.content_hash or '?')[:24]}",
            icon="CANCEL",
        )
    for line in rec.inconclusive[:5]:
        box.row().label(
            text=f"UNRESOLVED #{line.seq} {(line.filename or '?')[:24]}",
            icon="QUESTION",
        )
    return True


def draw_error(layout, m) -> bool:
    if not m.show_error:
        return False
    box = layout.box()
    box.label(text=HEADINGS[ERROR], icon="ERROR")
    box.label(text=m.last_error[:200])
    box.operator("scruple.clear_error", text="Dismiss", icon="X")
    return True
