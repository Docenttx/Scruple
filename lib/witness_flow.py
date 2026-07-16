"""Compose capture + client into a single witness action.

Kept as its own module because both the ambient handlers AND the
manual `scruple.witness_now` operator dispatch here — they only
differ in the trigger label.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from . import capture as _capture
from . import logging as _log
from . import scruple_client as _client_mod
from . import state as _state


def ensure_project(
    client: _client_mod.ScrupleClient,
    scene: Any,
    *,
    fallback_name: str = "Untitled Blender Project",
) -> int:
    """Return the project id for the current .blend, creating on first use."""
    st = _state.get()
    if st.active_project_id is not None:
        return st.active_project_id
    name = getattr(scene, "name", None) or fallback_name
    proj = client.create_project(name=name, kind="image")
    pid = proj.get("id")
    if pid is None:
        pid = (proj.get("project") or {}).get("id")
    if pid is None:
        raise RuntimeError(f"create_project did not return an id: {proj!r}")
    pid = int(pid)
    st.active_project_id = pid
    st.active_project_name = proj.get("name") or name
    st.active_project_status = proj.get("status") or "unlocked"
    return pid


def _post_leaf(
    client: _client_mod.ScrupleClient,
    scene: Any,
    payload: Dict[str, Any],
    *,
    trigger: str,
    prompt_prefix: str,
) -> Dict[str, Any]:
    pid = ensure_project(client, scene)
    prompt = f"{prompt_prefix} ({trigger}) - {payload['filename']}"
    resp = client.witness(
        pid,
        filename=payload["filename"],
        inline_base64=payload["inline_base64"],
        machine_manifest=payload["machine_manifest"],
        content_type=payload.get("content_type", "application/octet-stream"),
        prompt=prompt,
    )
    _state.get().record_receipt({
        "project_id": pid,
        "sha256": payload["sha256"],
        "filename": payload["filename"],
        "trigger": trigger,
        "kind": payload.get("kind"),
        "leaf_hash": resp.get("leafHash") or resp.get("leaf_hash"),
        "run_sequence": resp.get("runSequence") or resp.get("run_sequence"),
    })
    return resp


def witness_render(
    client: _client_mod.ScrupleClient,
    scene: Any,
    *,
    trigger: str = "render_complete",
    frame: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    payload = _capture.capture_render(scene, frame=frame)
    if payload is None:
        _log.info("witness_render: capture returned None (no output on disk)")
        return None
    return _post_leaf(client, scene, payload, trigger=trigger, prompt_prefix="blender-render")


def witness_save(
    client: _client_mod.ScrupleClient,
    scene: Any,
    blend_filepath: str,
    *,
    trigger: str = "save_post",
) -> Optional[Dict[str, Any]]:
    payload = _capture.capture_save(blend_filepath, scene)
    if payload is None:
        return None
    return _post_leaf(client, scene, payload, trigger=trigger, prompt_prefix="blender-save")


def witness_export(
    client: _client_mod.ScrupleClient,
    scene: Any,
    output_path: str,
    format: str,
    *,
    exporter_options: Optional[Dict[str, Any]] = None,
    trigger: str = "export_post",
) -> Optional[Dict[str, Any]]:
    payload = _capture.capture_export(
        output_path, scene, format=format, exporter_options=exporter_options,
    )
    if payload is None:
        return None
    return _post_leaf(
        client, scene, payload,
        trigger=trigger, prompt_prefix=f"blender-export-{format}",
    )
