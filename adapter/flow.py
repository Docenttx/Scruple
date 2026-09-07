"""Compose Blender's vocabulary onto the SDK's calls.

This file is what is left of lib/witness_flow.py and lib/paid_action.py
after the SDK took the parts that were not Blender's. It resolves a path
out of a scene, declares a MIME, builds a workflow dict, and hands all
three to `Client.witness_file()` / `Client.mark()`. It constructs no
requests, retries nothing, and decides no applicability -- all four of
those are on the list of things CANON_SKELETON.md §5 says an adapter may
not do, and each of them is a method on the Client instead.

THREE THINGS CHANGED SHAPE ON THE WAY ACROSS, AND ALL THREE ARE VISIBLE
FROM HERE:

1. `ensure_project()` is gone. It POSTed /api/projects to mint a v1
   project id for every .blend. There is no /api/v2/projects (gap.json,
   endpoints rows 1-3); v2 carries `project_id` as an optional integer
   on the leaf. The addon no longer creates projects, and passes one
   only if something set it.

2. `attach()` is new, and witnessing without it is refused. v2 leaves
   carry a `baseline_ref` and `witness_flow.witness()` raises
   `NoBaselineError` -- client-side, before any network call -- when the
   session has none. `ensure_attached()` below is the once-per-session
   call that establishes or verifies it.

3. A failure is no longer "an exception the caller logs". `witness()`
   returns a `WitnessOutcome` whose `witnessed` and `queued` are two
   different fields: witnessed=False,queued=True is "we could not reach
   the server and this is spooled on disk"; witnessed=False,queued=False
   on a delivered request is "the server took it and did not witness it".
   The old code inferred success from the absence of an exception.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from . import assurance as _assurance
from . import baseline_cache as _baseline_cache
from . import ledger as _ledger
from . import log as _log
from . import scene as _scene
from . import sdk as _sdk
from . import state as _state

from scruple_api import canonical as _canonical
from scruple_api.outcomes import MarkOutcome, Outstanding, WitnessOutcome
from scruple_host_sdk import capture as _capture


# ---- the v2 leaf `kind` vocabulary (WO-B3) -----------------------------
#
# THE REASON NO LEAF THIS ADDON PRODUCED HAS EVER LANDED.
#
# `kind` is a CLOSED enum on /api/v2/witness -- z.enum(['document_save',
# 'artifact', 'graph_execute', 'model_write']) at route.ts:110. This
# addon sent Blender's own words: 'render', 'save', 'export'. gap.json
# flagged it (endpoints row 4, "the addon's trigger labels are not
# members of it") and WO-B2 did not close it, because every test ran
# against a mock that accepted any string.
#
# Measured against the scratch app on 2026-09-07:
#
#     kind=render         -> invalid_body
#     kind=save           -> invalid_body
#     kind=export         -> invalid_body
#     kind=document_save  -> OK leaf_id=4
#     kind=artifact       -> OK leaf_id=5
#
# So the mapping below is not a tidy-up. Without it the addon cannot
# witness anything at all, and the 400 it gets back is NOT queued
# (http.py:162 queues transport failures and 5xx only) -- the capture is
# simply gone.
#
# Blender's own word is not thrown away: it stays in the workflow graph
# as `kind` (`blender_render` / `blender_save` / `blender_export`) and as
# `trigger`, both of which enter workflow_hash. The leaf says what class
# of event it was in the server's vocabulary; the graph says what Blender
# called it.
LEAF_KINDS = ("document_save", "artifact", "graph_execute", "model_write")

CAPTURE_KIND = {
    # A render is an artifact the pipeline produced, not a document the
    # user saved. `document_save` would be wrong even though it is the
    # friendlier-sounding member.
    "render": "artifact",
    # A .blend save is exactly what `document_save` is for.
    "save": "document_save",
    # An export writes a new artifact from the document.
    "export": "artifact",
}


class UnknownCaptureKind(ValueError):
    """Raised client-side, before any request, for a capture this adapter
    has no v2 leaf kind for. Refusing here rather than letting the server
    answer 400 is the difference between a bug that is visible in one
    place and a capture that vanishes: a 400 is not queued and not
    retried."""


def leaf_kind_for(capture_kind: str) -> str:
    try:
        kind = CAPTURE_KIND[capture_kind]
    except KeyError:
        raise UnknownCaptureKind(
            f"No /api/v2/witness leaf kind is mapped for capture {capture_kind!r}. "
            f"`kind` is a closed enum {LEAF_KINDS}; sending an unmapped value "
            f"produces invalid_body, which is NOT queued and NOT retried."
        ) from None
    # Belt and braces: a future edit to CAPTURE_KIND that introduces a
    # value outside the enum fails here rather than at the server.
    if kind not in LEAF_KINDS:
        raise UnknownCaptureKind(f"{kind!r} is not one of {LEAF_KINDS}")
    return kind


# ---- what leaves this machine ------------------------------------------

def graph_for_wire(workflow: Dict[str, Any]) -> Dict[str, Any]:
    """The workflow, with local filesystem paths reduced to basenames.

    WO-B3 starts SENDING the workflow as `graph` so the server computes
    `workflow_hash` and stamps a canonicalization profile on the row --
    before this, the workflow was only ever hashed into
    machine_manifest_hash and never transmitted. That changes what leaves
    the user's machine, so it gets a redaction rather than a shrug:
    `build_save_workflow` and `build_export_workflow` put an ABSOLUTE
    path in `filepath`, and /api/v2/witness is a zero-content surface
    whose whole argument is that the user's material stays put. A
    directory layout is the user's material.

    The basename is kept because it is already in the leaf's `filename`
    and in the render workflow, so redacting it would remove nothing an
    observer does not have.
    """
    out: Dict[str, Any] = {}
    for k, v in workflow.items():
        if k in ("filepath", "path", "directory") and isinstance(v, str) and v:
            out["filename"] = os.path.basename(v)
            continue
        out[k] = v
    return out


def _refused(reason: str) -> WitnessOutcome:
    """A witness that never went out, said so as an outcome rather than
    as a None. A caller that gets None cannot tell "there was nothing to
    witness" from "we declined to witness what was there"."""
    _state.set_error(reason)
    return WitnessOutcome(
        leaf_id=None,
        leaf_hash=None,
        witnessed=False,
        leaf_scheme=None,
        baseline_ref=None,
        queued=False,
        error=reason,
    )


def ensure_attached(client) -> bool:
    """Establish or verify this session's baseline. Idempotent: after the
    first success `client.state.baseline_ref` is set and this returns
    immediately.

    Returns False (and records the error) rather than raising, because
    every caller here is a Blender handler or operator and a raise would
    surface as a traceback in the console during a render.
    """
    if client.state.baseline_ref:
        return True
    try:
        result = client.attach(
            host_version=_scene.blender_version_string(),
            config={"host": _sdk.HOST},
            code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
        )
    except Exception as e:  # ScrupleAPIError, transport, anything
        # WO-B4. The offline branch, and the only place a baseline is ever
        # used without the server having just confirmed it.
        #
        # Measured before it was written (adapter/baseline_cache.py's
        # header): a Blender started while the server is unreachable
        # refused EVERY capture here and spooled none of them, because
        # attach() is a network call, SessionState is in memory, and
        # witness() refuses without a baseline_ref (D-3). Store-and-forward
        # was unreachable in the case it is most for.
        #
        # The cache is only usable when it was written by a LIVE attach
        # under the same tamper surface hash -- the same bytes, running
        # now. Different code is a different integration and gets no
        # baseline. Everything captured on a restored baseline goes into
        # the queue, and /api/v2/witness validates baseline_ref at ingest,
        # so a stale one is refused at drain time and is visible as a
        # rejection instead of as silence.
        restored = _restore_cached_baseline(client)
        if restored is not None:
            _log.warn(f"attach failed ({e}); continuing on the cached baseline {restored.baseline_ref[:16]}")
            _state.set_error(
                "Offline: running on the baseline last confirmed at "
                f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(restored.verified_at))}. "
                "Captures are being spooled and are NOT on the record; the server "
                "validates the baseline when they are delivered."
            )
            return True
        _log.warn(f"attach failed: {e}")
        _state.set_error(f"Could not establish a Scruple baseline: {e}")
        return False
    if result.drifted:
        # Not fatal and not silent: the server's active baseline is not
        # the hash of the files running right now.
        _log.warn(f"baseline drift: server={result.server_baseline_ref} local={client.state.tamper_surface_hash}")
        _state.set_error(
            "Baseline drift: this build's tamper surface does not match the "
            "baseline the server has on file."
        )
    _log.info(f"attached: baseline_ref={client.state.baseline_ref} established={result.established}")
    if client.state.baseline_ref:
        # Cached only after a LIVE attach. A baseline this client did not
        # just hear from the server is never written to the cache, so the
        # cache can never launder one session's guess into the next
        # session's fact.
        _baseline_cache.save(client)
    return bool(client.state.baseline_ref)


#: `/api/v2/baseline/rebaseline` closes `reason` to five values
#: (rebaseline/route.ts:29). `Client.rebaseline()` takes a free string and
#: validates nothing, so an unmapped reason is a 400 discovered at the
#: server -- the same shape as the `kind` enum WO-B3 found, and found the
#: same way: measured against the scratch app.
#:
#:     reason=integration_update -> invalid_enum_value
#:     reason=other              -> OK
#:
#: A rebaseline is NOT queued (attach and rebaseline are preconditions,
#: not Phase-3 events), so a 400 here raises rather than vanishing. It is
#: still refused client-side, because a build that cannot rebaseline
#: cannot witness and the reason should be legible in one place.
REBASELINE_REASONS = (
    "sdk_upgrade",
    "config_change",
    "host_upgrade",
    "capture_point_change",
    "other",
)


class UnknownRebaselineReason(ValueError):
    """Raised before any request for a reason the route does not accept."""


def rebaseline(client, *, reason: str, detail: Optional[str] = None):
    """Re-declare this build's tamper surface. `reason` is checked against
    the route's closed enum here, not at the server."""
    if reason not in REBASELINE_REASONS:
        raise UnknownRebaselineReason(
            f"{reason!r} is not one of {REBASELINE_REASONS}; "
            f"/api/v2/baseline/rebaseline answers invalid_enum_value for anything else."
        )
    result = client.rebaseline(
        reason=reason,
        detail=detail,
        config={"host": _sdk.HOST},
        code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
    )
    if client.state.baseline_ref:
        _baseline_cache.save(client)
    return result


def _restore_cached_baseline(client):
    """The cached baseline for THIS build, or None. See
    adapter/baseline_cache.py for the three rules."""
    from scruple_host_sdk import manifest as _manifest

    try:
        tsh = _manifest.compute_tamper_surface_hash(
            integration_version=client.integration_version,
            config={"host": _sdk.HOST},
            code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
        )
    except Exception as e:
        _log.warn(f"could not compute the tamper surface hash offline: {e}")
        return None
    return _baseline_cache.restore_if_same_build(client, tsh)


def _witness_path(
    client,
    path: str,
    *,
    mime: str,
    kind: str,
    workflow: Dict[str, Any],
) -> WitnessOutcome:
    """Witness one file and record what is actually known about the leaf.

    `kind` is Blender's word ('render' / 'save' / 'export'); it is
    translated to the closed v2 enum by `leaf_kind_for()` and refused
    here if it has no member (see that function for why a server-side
    refusal is not good enough).
    """
    try:
        leaf_kind = leaf_kind_for(kind)
    except UnknownCaptureKind as e:
        return _refused_with_assurance(str(e), kind=kind, mime=mime, client=client, filename=os.path.basename(path))

    if os.path.getsize(path) > _capture.INLINE_PAYLOAD_LIMIT_BYTES:
        return _refused_with_assurance(
            f"{os.path.basename(path)} is over the "
            f"{_capture.INLINE_PAYLOAD_LIMIT_BYTES}-byte inline limit and was not witnessed.",
            kind=kind, mime=mime, client=client, filename=os.path.basename(path),
        )
    if not ensure_attached(client):
        return _refused_with_assurance(
            _state.get().last_error or "No baseline; nothing was witnessed.",
            kind=kind, mime=mime, client=client, filename=os.path.basename(path),
        )

    # The graph is what makes the server compute workflow_hash and stamp a
    # canonicalization profile on the row; before WO-B3 the workflow was
    # only ever folded into machine_manifest_hash and the leaf carried no
    # workflow at all. Redacted for the wire -- see graph_for_wire().
    graph = graph_for_wire(workflow)
    try:
        client_workflow_hash = _canonical.hash_workflow(graph)
    except Exception as e:
        # scruple_api.canonical REFUSES documents with no canonical form
        # (NaN, Infinity, a stray object) rather than hashing them to
        # something meaningless. A workflow that cannot be canonicalized
        # must not be sent: the server would compute a DIFFERENT
        # workflow_hash or refuse, and either way the leaf would commit to
        # something this client cannot reproduce.
        return _refused_with_assurance(
            f"Workflow has no canonical form and was not sent: {e}",
            kind=kind, mime=mime, client=client, filename=os.path.basename(path),
        )

    # WO-B4. `Client.witness_file()` is capture() + witness() in one call,
    # and the ledger line has to go BETWEEN them: written once the content
    # hash exists and before anything is sent, so that a process killed
    # mid-request still leaves a record that this capture was attempted.
    # There is no seam inside witness_file() to put it in, so the two SDK
    # calls it composes are made here instead -- the same two calls, in the
    # same order, with the receipt recorded exactly as it records it.
    payload = client.capture(path, mime=mime, kind=leaf_kind, workflow=workflow)
    content_hash = payload["content_hash"]
    led = _ledger.get(client)
    line = None
    if led is not None:
        line = led.record_intent(
            kind=kind,
            leaf_kind=leaf_kind,
            mime=mime,
            content_hash=content_hash,
            filename=payload["filename"],
        )

    outcome = client.witness(
        kind=leaf_kind,
        content_hash=content_hash,
        mime=mime,
        graph=graph,
        project_id=_state.get().active_project_id,
        machine_manifest_hash=machine_manifest_hash(client, workflow),
    )
    client.state.record_receipt(
        {
            "filename": payload["filename"],
            "content_hash": content_hash,
            "leaf_id": outcome.leaf_id,
            "witnessed": outcome.witnessed,
            "queued": outcome.queued,
        }
    )
    record = _assurance.from_outcome(
        outcome,
        kind=kind,
        mime=mime,
        content_hash=content_hash,
        filename=os.path.basename(path),
        client_workflow_hash=client_workflow_hash,
        queue_depth_after=client.queue_depth,
    )
    if led is not None and line is not None:
        # The ledger records the OUTCOME state, not a success flag. A
        # queued line keeps the id of the queue entry holding it, so
        # settlement can tell "still spooled" from "spooled and then lost"
        # -- which is the difference between outstanding and a gap.
        led.update(
            line["id"],
            state=record.state,
            leaf_id=outcome.leaf_id,
            queue_id=_queue_id_for(client, content_hash) if outcome.queued else None,
            error=outcome.error,
        )
    _state.remember_leaf(leaf_id=outcome.leaf_id, mime=mime, content_hash=content_hash)
    _state.record_assurance(record)
    if outcome.error:
        _state.set_error(outcome.error)
    _log.info(
        f"witness {kind}->{leaf_kind} {os.path.basename(path)} -> "
        f"leaf={outcome.leaf_id} state={record.state} tier={record.assurance_tier}"
    )
    return outcome


def _queue_id_for(client, content_hash: str) -> Optional[str]:
    """The id of the spooled entry holding this capture, if any.

    `WitnessOutcome` does not carry it -- `http.Result` does, and
    `witness_flow.witness()` does not pass it on -- so it is recovered by
    matching the content hash against the bodies the queue stored. That
    match is exact: the queued body IS the submission.
    """
    for e in reversed(client.queue.load_all()):
        body = e.get("body") or {}
        if body.get("content_hash") == content_hash:
            return str(e.get("id"))
    return None


def _refused_with_assurance(
    reason: str, *, kind: str, mime: Optional[str], client=None, filename: Optional[str] = None
) -> WitnessOutcome:
    """A local refusal, recorded on the assurance surface as well as the
    error line. A capture that never left the machine must be visible as
    REFUSED_LOCALLY and not merely as a missing row -- silence and refusal
    read the same otherwise, which is the failure vendor floor item 5 is
    about."""
    _state.record_assurance(_assurance.refused(reason, kind=kind, mime=mime))
    # And on the LEDGER, with no content hash, because a capture refused
    # before it was hashed has none. Settlement reports it as
    # `refused_locally` -- accounted for, with a reason, and therefore not
    # a gap. Leaving it out of the ledger would make a refused session and
    # an idle session produce the same file.
    led = _ledger.get(client) if client is not None else _ledger.get()
    if led is not None:
        led.record_intent(
            kind=kind,
            leaf_kind=None,
            mime=mime,
            content_hash=None,
            filename=filename,
            state=_ledger.REFUSED_LOCALLY,
            error=reason,
        )
    return _refused(reason)


# ---- reading the record back (WO-B3) -----------------------------------

def fetch_receipt(client, leaf_id: str) -> Optional[Dict[str, Any]]:
    """GET /api/v2/receipt/{leaf_id}. Public and unauthenticated by
    design, and per its own header "deliberately unflattering" -- which is
    why it is worth fetching rather than rendering the addon's own idea of
    what happened. Returns None and records the error rather than raising:
    every caller is an operator or a handler."""
    try:
        return client.receipt(leaf_id)
    except Exception as e:
        _log.warn(f"receipt({leaf_id}) failed: {e}")
        _state.set_error(f"Could not fetch receipt for leaf {leaf_id}: {e}")
        return None


def verify_content(client, content_hash: str) -> Optional[Dict[str, Any]]:
    """GET /api/v2/verify/{content_hash} -- the third-party check, run
    from here so a user can see it without leaving Blender.

    What comes back is a CLAIM, not a verification this client performed.
    `assurance.with_verification` keeps those two apart deliberately; read
    its docstring before trusting `independently_verifiable`."""
    try:
        return client.verify(content_hash)
    except Exception as e:
        _log.warn(f"verify({content_hash[:16]}) failed: {e}")
        _state.set_error(f"Could not verify {content_hash[:16]}...: {e}")
        return None


def resolve_assurance(client, record) -> "_assurance.LeafAssurance":
    """Fold the receipt and the verification into an assurance record.

    Both calls are queries, not operations -- http.submit gives them
    queue_kind=None, so a failure here is reported and never spooled.
    A leaf that is not on the record yet (queued, rejected, refused) has
    nothing to fetch and is returned unchanged rather than being asked
    about.
    """
    if not record.leaf_id:
        return record
    receipt = fetch_receipt(client, record.leaf_id)
    if receipt is not None:
        record = _assurance.with_receipt(record, receipt)
        # WO-B6. Check the seal here, against the key the RECEIPT names.
        # Nothing else in this addon may decide where the verifying key
        # lives; when the receipt publishes no address the check does not
        # run and says so, which is a different record from a check that
        # ran and failed.
        record = _assurance.check_signature(record, fetch_key=client.published_key)
    if record.content_hash:
        verification = verify_content(client, record.content_hash)
        if verification is not None:
            record = _assurance.with_verification(record, verification)
    _state.record_assurance(record, replace_leaf_id=record.leaf_id)
    return record


def machine_manifest_hash(client, workflow: Dict[str, Any]) -> str:
    """The SDK's host-agnostic manifest plus Blender's own fields, hashed
    with the SDK's canonicalizer. lib/manifest.py hardcoded
    blender_version/addon into the manifest itself; the SDK keeps those
    in `extra` so one canonical form covers every host."""
    from scruple_host_sdk import manifest as _manifest

    m = _manifest.build_machine_manifest(
        host=_sdk.HOST,
        integration_version=_sdk.integration_version(),
        host_version=_scene.blender_version_string(),
        extra=_scene.host_environment(),
    )
    m["workflow"] = workflow
    return _manifest.machine_manifest_hash(m)


def _last_content_hash(client) -> Optional[str]:
    receipts = list(client.state.recent_receipts)
    return receipts[0].get("content_hash") if receipts else None


# ---- the three ambient captures ----------------------------------------

def witness_render(
    client,
    scene: Any,
    *,
    trigger: str = "render_complete",
    frame: Optional[int] = None,
) -> Optional[WitnessOutcome]:
    """Witness the file this render wrote. None -- and only None -- means
    there is no such file yet."""
    path = _scene.resolved_render_output(scene, frame=frame)
    if not path or not os.path.exists(path):
        _log.info(f"witness_render: no file at {path!r}")
        return None
    try:
        mime = _scene.mime_for_render(scene)
    except Exception as e:
        # An undeclarable format is a REFUSAL, and it goes on the tracker
        # as one. Property 1 forbids guessing a MIME; it does not licence
        # dropping the capture silently.
        return _refused_with_assurance(str(e), kind="render", mime=None, client=client, filename=os.path.basename(path))
    settings = _scene.read_render_settings(scene)
    workflow = _scene.build_render_workflow(
        filename=os.path.basename(path),
        scene_name=getattr(scene, "name", "Scene"),
        render_engine=settings.get("engine", ""),
        resolution=settings.get("resolution", (0, 0)),
        samples=settings.get("samples"),
        camera=settings.get("camera"),
        frame=frame,
        trigger=trigger,
    )
    return _witness_path(client, path, mime=mime, kind="render", workflow=workflow)


def witness_save(
    client,
    scene: Any,
    blend_filepath: str,
    *,
    trigger: str = "save_post",
) -> Optional[WitnessOutcome]:
    if not blend_filepath or not os.path.exists(blend_filepath):
        _log.info(f"witness_save: no file at {blend_filepath!r}")
        return None
    inv = _scene.scene_inventory(scene)
    workflow = _scene.build_save_workflow(
        filepath=blend_filepath,
        scene_name=getattr(scene, "name", "Scene"),
        object_count=inv["object_count"],
        material_count=inv["material_count"],
        trigger=trigger,
    )
    return _witness_path(
        client, blend_filepath, mime=_scene.BLEND_MIME, kind="save", workflow=workflow,
    )


def witness_export(
    client,
    scene: Any,
    output_path: str,
    format: str,
    *,
    mime: Optional[str] = None,
    exporter_options: Optional[Dict[str, Any]] = None,
    trigger: str = "export_post",
) -> Optional[WitnessOutcome]:
    if not output_path or not os.path.exists(output_path):
        _log.info(f"witness_export: no file at {output_path!r}")
        return None
    try:
        declared = _scene.mime_for_export(format, output_path, declared=mime)
    except Exception as e:
        return _refused_with_assurance(str(e), kind="export", mime=mime, client=client, filename=os.path.basename(output_path))
    workflow = _scene.build_export_workflow(
        filepath=output_path,
        format=format,
        scene_name=getattr(scene, "name", "Scene"),
        exporter_options=exporter_options,
        trigger=trigger,
    )
    return _witness_path(client, output_path, mime=declared, kind="export", workflow=workflow)


# ---- paid actions ------------------------------------------------------
# lib/paid_action.py's spine was charge -> call a per-operator
# `submit_lock` callable -> record a receipt. Under v2 there is one
# endpoint, /api/v2/mark, and the operators differ only in the modality
# list they ask for -- so the callable seam is gone and this is a plain
# function per modality set.


def mark_local(client, *, leaf_id: str, mime: str, payment_intent_id: Optional[str] = None) -> MarkOutcome:
    """Standard §9.4 finalize. modalities=[] is not "nothing": a local
    lock is always performed server-side (D-5), and asking for no
    additional modality is exactly what /api/lock/local used to mean."""
    return client.mark(leaf_id=leaf_id, mime=mime, modalities=[], payment_intent_id=payment_intent_id)


def mark_chain(
    client, *, leaf_id: str, mime: str, tier: str = "pinned", payment_intent_id: Optional[str] = None
) -> MarkOutcome:
    return client.mark(
        leaf_id=leaf_id, mime=mime, modalities=["chain"], chain_tier=tier,
        payment_intent_id=payment_intent_id,
    )


def outstanding_summary(outcome: MarkOutcome) -> str:
    """What a paid action did NOT do, in one line for the operator's
    report. §9.5: `outstanding` is honest, so it gets shown rather than
    reduced to a success message."""
    if not outcome.outstanding:
        return ""
    return "; ".join(f"{o.modality}: {o.reason}" for o in outcome.outstanding)
