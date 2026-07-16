"""Output capture pipeline.

Given an event (render complete, save post, export post) and a bpy-ish
scene handle, this module:

  1. Resolves the on-disk output path Blender just wrote.
  2. Streams SHA-256 over the bytes (large files are common).
  3. Reads a small set of render / scene properties to build a
     workflow snapshot — enough to make the receipt legible, not so
     much that we start capturing user data.
  4. Assembles the witness leaf payload (bytes + machine_manifest +
     workflow) ready for ScrupleClient.witness().

Everything here is bpy-optional. When bpy is unavailable (tests) the
mock-bpy harness in tests/mocks/bpy_mock.py stands in.
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any, Dict, Optional

from . import manifest as _manifest
from . import logging as _log

CHUNK_SIZE = 1024 * 1024
INLINE_PAYLOAD_LIMIT_BYTES = 25 * 1024 * 1024


def sha256_file(path: str, chunk: int = CHUNK_SIZE) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def inline_base64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def resolved_render_output(scene: Any, frame: Optional[int] = None) -> Optional[str]:
    """Best-effort resolution of the file Blender wrote.

    `scene.render.filepath` returns Blender's format string (with tokens
    like `####`). For a single render Blender substitutes the current
    frame into the trailing hashes. We mimic that so tests match reality
    without importing bpy.
    """
    fp = getattr(getattr(scene, "render", None), "filepath", "") or ""
    if not fp:
        return None
    fp = os.path.abspath(bpy_path_abspath(fp))
    if frame is None:
        try:
            frame = int(getattr(scene, "frame_current", 1))
        except (TypeError, ValueError):
            frame = 1
    return _substitute_frame_hashes(fp, frame)


def bpy_path_abspath(p: str) -> str:
    """Expand `//`-relative paths without depending on bpy at import time."""
    try:
        import bpy
        return bpy.path.abspath(p)
    except Exception:
        if p.startswith("//"):
            return os.path.abspath(p[2:])
        return os.path.abspath(os.path.expanduser(p))


def _substitute_frame_hashes(path: str, frame: int) -> str:
    """Replace a trailing run of `#` characters with a zero-padded frame."""
    stem, ext = os.path.splitext(path)
    hashes = 0
    for ch in reversed(stem):
        if ch == "#":
            hashes += 1
        else:
            break
    if hashes == 0:
        return path
    padded = str(int(frame)).zfill(hashes)
    return stem[:-hashes] + padded + ext


def scene_inventory(scene: Any) -> Dict[str, int]:
    objects = getattr(scene, "objects", None)
    object_count = len(list(objects)) if objects is not None else 0
    material_count = 0
    try:
        import bpy
        material_count = len(list(bpy.data.materials))
    except Exception:
        pass
    return {"object_count": object_count, "material_count": material_count}


def read_render_settings(scene: Any) -> Dict[str, Any]:
    render = getattr(scene, "render", None)
    if render is None:
        return {}
    resolution = (
        getattr(render, "resolution_x", 0),
        getattr(render, "resolution_y", 0),
    )
    engine = getattr(render, "engine", "") or ""
    camera = getattr(getattr(scene, "camera", None), "name", None)
    samples: Optional[int] = None
    for group in ("cycles", "eevee"):
        sub = getattr(scene, group, None)
        if sub is not None and hasattr(sub, "samples"):
            try:
                samples = int(sub.samples)
                break
            except (TypeError, ValueError):
                pass
    return {
        "resolution": resolution,
        "engine": engine,
        "camera": camera,
        "samples": samples,
    }


def enabled_addons_list() -> list:
    try:
        import bpy
        return sorted(list(bpy.context.preferences.addons.keys()))
    except Exception:
        return []


def blender_version_string() -> str:
    try:
        import bpy
        v = bpy.app.version
        return f"{v[0]}.{v[1]}.{v[2]}"
    except Exception:
        return _manifest.DEFAULT_BLENDER_VERSION


def _size_ok(path: str) -> bool:
    try:
        return os.path.getsize(path) <= INLINE_PAYLOAD_LIMIT_BYTES
    except OSError:
        return False


def capture_render(
    scene: Any,
    *,
    frame: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Build a leaf payload for a completed render. Returns None if the
    output file cannot be located on disk."""
    path = resolved_render_output(scene, frame=frame)
    if not path or not os.path.exists(path):
        _log.info(f"capture_render: no file at {path!r}")
        return None
    if not _size_ok(path):
        _log.warn(f"capture_render: {path} exceeds inline limit; skipping")
        return None
    digest = sha256_file(path)
    settings = read_render_settings(scene)
    workflow = _manifest.build_render_workflow(
        filename=os.path.basename(path),
        scene_name=getattr(scene, "name", "Scene"),
        render_engine=settings.get("engine", ""),
        resolution=settings.get("resolution", (0, 0)),
        samples=settings.get("samples"),
        camera=settings.get("camera"),
        frame=frame,
    )
    machine_manifest = _manifest.build_machine_manifest(
        blender_version=blender_version_string(),
        enabled_addons=enabled_addons_list(),
        render_engine=settings.get("engine"),
    )
    machine_manifest["workflow"] = workflow
    return {
        "filepath": path,
        "filename": os.path.basename(path),
        "sha256": digest,
        "inline_base64": inline_base64(path),
        "machine_manifest": machine_manifest,
        "workflow": workflow,
        "kind": "render",
    }


def capture_save(blend_filepath: str, scene: Any) -> Optional[Dict[str, Any]]:
    if not blend_filepath or not os.path.exists(blend_filepath):
        _log.info(f"capture_save: no file at {blend_filepath!r}")
        return None
    if not _size_ok(blend_filepath):
        _log.warn(f"capture_save: {blend_filepath} exceeds inline limit; skipping")
        return None
    digest = sha256_file(blend_filepath)
    inv = scene_inventory(scene)
    workflow = _manifest.build_save_workflow(
        filepath=blend_filepath,
        scene_name=getattr(scene, "name", "Scene"),
        object_count=inv["object_count"],
        material_count=inv["material_count"],
    )
    machine_manifest = _manifest.build_machine_manifest(
        blender_version=blender_version_string(),
        enabled_addons=enabled_addons_list(),
    )
    machine_manifest["workflow"] = workflow
    return {
        "filepath": blend_filepath,
        "filename": os.path.basename(blend_filepath),
        "sha256": digest,
        "inline_base64": inline_base64(blend_filepath),
        "machine_manifest": machine_manifest,
        "workflow": workflow,
        "kind": "save",
    }


def capture_export(
    output_path: str,
    scene: Any,
    *,
    format: str,
    exporter_options: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    if not output_path or not os.path.exists(output_path):
        _log.info(f"capture_export: no file at {output_path!r}")
        return None
    if not _size_ok(output_path):
        _log.warn(f"capture_export: {output_path} exceeds inline limit; skipping")
        return None
    digest = sha256_file(output_path)
    workflow = _manifest.build_export_workflow(
        filepath=output_path,
        format=format,
        scene_name=getattr(scene, "name", "Scene"),
        exporter_options=exporter_options,
    )
    machine_manifest = _manifest.build_machine_manifest(
        blender_version=blender_version_string(),
        enabled_addons=enabled_addons_list(),
    )
    machine_manifest["workflow"] = workflow
    return {
        "filepath": output_path,
        "filename": os.path.basename(output_path),
        "sha256": digest,
        "inline_base64": inline_base64(output_path),
        "machine_manifest": machine_manifest,
        "workflow": workflow,
        "kind": "export",
        "format": format,
    }
