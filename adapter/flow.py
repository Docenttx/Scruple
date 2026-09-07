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
from typing import Any, Dict, List, Optional

from . import log as _log
from . import scene as _scene
from . import sdk as _sdk
from . import state as _state

from scruple_api.outcomes import MarkOutcome, Outstanding, WitnessOutcome
from scruple_host_sdk import capture as _capture


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
    return bool(client.state.baseline_ref)


def _witness_path(
    client,
    path: str,
    *,
    mime: str,
    kind: str,
    workflow: Dict[str, Any],
) -> WitnessOutcome:
    if os.path.getsize(path) > _capture.INLINE_PAYLOAD_LIMIT_BYTES:
        return _refused(
            f"{os.path.basename(path)} is over the "
            f"{_capture.INLINE_PAYLOAD_LIMIT_BYTES}-byte inline limit and was not witnessed."
        )
    if not ensure_attached(client):
        return _refused(_state.get().last_error or "No baseline; nothing was witnessed.")

    outcome = client.witness_file(
        path,
        mime=mime,
        kind=kind,
        workflow=workflow,
        project_id=_state.get().active_project_id,
        machine_manifest_hash=machine_manifest_hash(client, workflow),
    )
    _state.remember_leaf(
        leaf_id=outcome.leaf_id,
        mime=mime,
        content_hash=_last_content_hash(client),
    )
    if outcome.error:
        _state.set_error(outcome.error)
    _log.info(
        f"witness {kind} {os.path.basename(path)} -> "
        f"leaf={outcome.leaf_id} witnessed={outcome.witnessed} queued={outcome.queued}"
    )
    return outcome


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
        return _refused(str(e))
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
        return _refused(str(e))
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
