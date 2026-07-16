"""Canonical machine + workflow manifest builders.

The witness server hashes a canonical JSON serialization of the
machine_manifest and folds it into the leaf preimage. Field order does
not matter to the hash because the server sorts keys, but we still keep
these dicts small and stable to make receipts readable.

Mirrors /data/scruple-fusion/lib/witness.py's build_machine_manifest so
the two plugins produce leaves that a receipt viewer can distinguish
by `host` alone.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

ADDON_VERSION = "0.1.0"
DEFAULT_BLENDER_VERSION = "unknown"


def canonicalize(obj: Any) -> str:
    """Sorted-keys, no-whitespace JSON. Byte-for-byte matches the server."""
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return "{" + ",".join(
            json.dumps(k) + ":" + canonicalize(obj[k]) for k in keys
        ) + "}"
    if isinstance(obj, list):
        return "[" + ",".join(canonicalize(v) for v in obj) + "]"
    return json.dumps(obj)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def build_machine_manifest(
    blender_version: str = DEFAULT_BLENDER_VERSION,
    *,
    enabled_addons: Optional[list] = None,
    render_engine: Optional[str] = None,
) -> Dict[str, Any]:
    m: Dict[str, Any] = {
        "host": "blender",
        "blender_version": blender_version,
        "addon": "scruple-blender",
        "addon_version": ADDON_VERSION,
    }
    if enabled_addons:
        m["enabled_addons"] = sorted(set(enabled_addons))
    if render_engine:
        m["render_engine"] = render_engine
    return m


def machine_manifest_hash(manifest: Dict[str, Any]) -> str:
    """The server computes the same hash internally; we expose it here for
    tests + so we can display the short hash in the Blender N-panel."""
    return sha256_hex(canonicalize(manifest))


def build_render_workflow(
    *,
    filename: str,
    scene_name: str,
    render_engine: str,
    resolution: tuple,
    samples: Optional[int],
    camera: Optional[str],
    frame: Optional[int] = None,
) -> Dict[str, Any]:
    """The workflow_api_json equivalent for a Blender render — a stable
    snapshot of the settings that shaped this output."""
    workflow: Dict[str, Any] = {
        "kind": "blender_render",
        "filename": filename,
        "scene": scene_name,
        "engine": render_engine,
        "resolution": [int(resolution[0]), int(resolution[1])],
    }
    if samples is not None:
        workflow["samples"] = int(samples)
    if camera:
        workflow["camera"] = camera
    if frame is not None:
        workflow["frame"] = int(frame)
    return workflow


def build_save_workflow(
    *,
    filepath: str,
    scene_name: str,
    object_count: int,
    material_count: int,
) -> Dict[str, Any]:
    return {
        "kind": "blender_save",
        "filepath": filepath,
        "scene": scene_name,
        "object_count": int(object_count),
        "material_count": int(material_count),
    }


def build_export_workflow(
    *,
    filepath: str,
    format: str,
    scene_name: str,
    exporter_options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    workflow: Dict[str, Any] = {
        "kind": "blender_export",
        "filepath": filepath,
        "format": format.lower(),
        "scene": scene_name,
    }
    if exporter_options:
        workflow["options"] = dict(exporter_options)
    return workflow
