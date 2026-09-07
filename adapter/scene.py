"""Reading Blender: output paths, render settings, scene inventory, and
the MIME type of what Blender just wrote.

This is the half of the old lib/capture.py that gap.json says must
survive: "the hashing half of this module is superseded; the bpy-reading
half must SURVIVE as adapter code". Hashing, base64 and the inline-size
limit now come from `scruple_api.capture` via the SDK; nothing in this
file opens a file for reading bytes.

WHY THERE IS A MIME TABLE HERE AND NOT A `mimetypes` CALL

The old addon declared no MIME at all, so `witness_flow`'s
`payload.get("content_type", "application/octet-stream")` fired on every
leaf and every Blender artifact -- PNG, EXR, MP4, .blend -- was witnessed
as an opaque blob. `scruple_api.capture.require_mime()` refuses to
proceed without an explicit one, and there is no `mimetypes` import in
either SDK package by design (an extension-based guess is what GPSA v3
flagged for breaking `.flac` and `.jxl`).

So the type is DECLARED, from what Blender itself says it wrote:
`scene.render.image_settings.file_format` is Blender's own enum for the
format it just encoded, not a guess from the filename. A format not in
the table raises `MimeRequiredError` rather than falling back -- an
unknown format is a missing table row, and a silent
`application/octet-stream` is how the last three years of leaves lost
their type.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from . import log as _log
from scruple_api.errors import MimeRequiredError

#: Blender's `ImageFormatSettings.file_format` enum -> the type Blender
#: encoded. Keys are Blender's spelling, verbatim.
RENDER_FORMAT_MIME: Dict[str, str] = {
    "BMP": "image/bmp",
    "IRIS": "image/x-rgb",
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "JPEG2000": "image/jp2",
    "TARGA": "image/x-tga",
    "TARGA_RAW": "image/x-tga",
    "CINEON": "image/cineon",
    "DPX": "image/x-dpx",
    "OPEN_EXR": "image/x-exr",
    "OPEN_EXR_MULTILAYER": "image/x-exr",
    "HDR": "image/vnd.radiance",
    "TIFF": "image/tiff",
    "WEBP": "image/webp",
    "AVI_JPEG": "video/x-msvideo",
    "AVI_RAW": "video/x-msvideo",
}

#: `FFmpegSettings.format` -> container type. FFMPEG is the one
#: file_format whose type depends on a second enum, so it is resolved in
#: two steps rather than assumed to be MP4.
FFMPEG_CONTAINER_MIME: Dict[str, str] = {
    "MPEG1": "video/mpeg",
    "MPEG2": "video/mpeg",
    "MPEG4": "video/mp4",
    "AVI": "video/x-msvideo",
    "QUICKTIME": "video/quicktime",
    "DV": "video/x-dv",
    "OGG": "video/ogg",
    "MKV": "video/x-matroska",
    "MATROSKA": "video/x-matroska",
    "FLASH": "video/x-flv",
    "WEBM": "video/webm",
}

#: A .blend is a Blender file and nothing else; this one is not a guess
#: in any sense.
BLEND_MIME = "application/x-blender"

#: Export formats the addon offers. `fbx` is declared
#: application/octet-stream because FBX is a proprietary binary with no
#: registered media type -- that is a declaration that this IS an opaque
#: binary, not the old default that everything is.
EXPORT_FORMAT_MIME: Dict[str, str] = {
    "obj": "model/obj",
    "fbx": "application/octet-stream",
    "usd": "model/vnd.usd",
    "usdz": "model/vnd.usdz+zip",
    "stl": "model/stl",
    "ply": "application/octet-stream",
    "abc": "application/octet-stream",
    "dae": "model/vnd.collada+xml",
}

#: Fallback for the extension Blender appends, used only when
#: `scene.render.file_extension` is unavailable (the mock harness, or a
#: bpy old enough not to expose it). Blender is the authority: it reports
#: ".jpg" for JPEG, not ".jpeg", which is exactly the kind of detail a
#: hand-written table gets wrong.
RENDER_FORMAT_EXT = {
    "PNG": ".png", "JPEG": ".jpg", "JPEG2000": ".jp2", "BMP": ".bmp",
    "IRIS": ".rgb", "TARGA": ".tga", "TARGA_RAW": ".tga", "CINEON": ".cin",
    "DPX": ".dpx", "OPEN_EXR": ".exr", "OPEN_EXR_MULTILAYER": ".exr",
    "HDR": ".hdr", "TIFF": ".tif", "WEBP": ".webp",
}

DEFAULT_BLENDER_VERSION = "unknown"


# ---- paths --------------------------------------------------------------
# WHAT BLENDER ACTUALLY WRITES, MEASURED RATHER THAN ASSUMED.
#
# The path resolution inherited from lib/capture.py substituted `####`
# with the frame number and returned that. Run against real Blender
# 3.0.1 headless it finds nothing, because it never appends the format
# extension -- `filepath = "/x/out"` with PNG produces `/x/out.png`, and
# the old code looked for `/x/out`. A capture that silently never
# happens is the failure class this whole series is about, so the rules
# below are what Blender was observed to do, not what the docs imply:
#
#   filepath="/x/still",  write_still  -> /x/still.png     (ext appended)
#   filepath="/x/w.png",  write_still  -> /x/w.png         (not doubled)
#   filepath="/x/h####",  write_still  -> /x/h####.png     (### NOT substituted)
#   filepath="/x/anim",   animation    -> /x/anim0003.png  (frame appended)
#   filepath="/x/a####",  animation    -> /x/a0005.png     (### substituted)
#   filepath="/x/a_##",   animation    -> /x/a_12.png      (padded to width)
#   use_file_extension=False           -> no extension at all
#   JPEG                               -> ".jpg", not ".jpeg"
#
# A still render and an animation frame therefore land at different
# paths from the same `filepath`, and the handler that fires cannot tell
# us which. So rather than re-deriving Blender's branch, this module
# builds the candidates and returns the one that is ON DISK.

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


def _append_frame(path: str, frame: int, width: int = 4) -> str:
    stem, ext = os.path.splitext(path)
    return f"{stem}{int(frame):0{width}d}{ext}"


def render_file_extension(scene: Any) -> str:
    """The extension Blender appends, from Blender itself where possible.

    `scene.render.file_extension` is read-only and format-aware; the
    table is a fallback for harnesses that do not model it. Returns ""
    when `use_file_extension` is off, because then Blender appends
    nothing.
    """
    render = getattr(scene, "render", None)
    if render is None:
        return ""
    if not getattr(render, "use_file_extension", True):
        return ""
    ext = getattr(render, "file_extension", "") or ""
    if ext:
        return ext
    return RENDER_FORMAT_EXT.get(render_file_format(scene), "")


def _with_extension(path: str, ext: str) -> str:
    if not ext or path.lower().endswith(ext.lower()):
        return path
    return path + ext


def candidate_render_outputs(scene: Any, frame: Optional[int] = None) -> list:
    """Every path Blender could have written for this scene, in the order
    it is worth looking. See the note above for what each one is."""
    fp = getattr(getattr(scene, "render", None), "filepath", "") or ""
    if not fp:
        return []
    fp = os.path.abspath(bpy_path_abspath(fp))
    if frame is None:
        try:
            frame = int(getattr(scene, "frame_current", 1))
        except (TypeError, ValueError):
            frame = 1
    ext = render_file_extension(scene)

    candidates = [
        _with_extension(fp, ext),                                  # still render
        _with_extension(_substitute_frame_hashes(fp, frame), ext),  # animation, #### tokens
        _with_extension(_append_frame(fp, frame), ext),             # animation, no tokens
    ]
    seen = set()
    ordered = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def resolved_render_output(scene: Any, frame: Optional[int] = None) -> Optional[str]:
    """The file Blender wrote, if one of the candidates is on disk.

    Falls back to the first candidate when none exists, so the caller's
    "no file at X" log names the path that was actually looked for
    rather than saying nothing.
    """
    candidates = candidate_render_outputs(scene, frame=frame)
    if not candidates:
        return None
    for path in candidates:
        if os.path.exists(path):
            return path
    return candidates[0]


# ---- MIME, declared -----------------------------------------------------

def render_file_format(scene: Any) -> str:
    """Blender's own name for the format it encoded, e.g. "PNG"."""
    settings = getattr(getattr(scene, "render", None), "image_settings", None)
    return (getattr(settings, "file_format", "") or "").upper()


def mime_for_render(scene: Any) -> str:
    """The declared type of this scene's render output.

    Raises MimeRequiredError for a format with no row in the table. That
    refusal is the point: it stops one unmapped format from re-opening
    the octet-stream hole for every leaf.
    """
    fmt = render_file_format(scene)
    if not fmt:
        raise MimeRequiredError(
            "scene.render.image_settings.file_format is empty, so the type of "
            "the render output is not known. Refusing to guess it from the "
            "file extension -- declare it on the operator instead."
        )
    if fmt == "FFMPEG":
        container = (getattr(getattr(scene, "render", None), "ffmpeg", None) and
                     getattr(scene.render.ffmpeg, "format", "")) or ""
        container = container.upper()
        mime = FFMPEG_CONTAINER_MIME.get(container)
        if mime is None:
            raise MimeRequiredError(
                f"FFMPEG container {container!r} has no declared media type in "
                "adapter/scene.py::FFMPEG_CONTAINER_MIME. Add the row rather "
                "than defaulting to video/mp4."
            )
        return mime
    mime = RENDER_FORMAT_MIME.get(fmt)
    if mime is None:
        raise MimeRequiredError(
            f"Blender render format {fmt!r} has no declared media type in "
            "adapter/scene.py::RENDER_FORMAT_MIME. Add the row rather than "
            "falling back to application/octet-stream."
        )
    return mime


def mime_for_export(format: str, path: str = "", *, declared: Optional[str] = None) -> str:
    """The declared type of an exported file.

    `declared` wins when the operator was given one -- that is the escape
    hatch for the "other" format, and it is an explicit declaration by
    the user, not a guess by us.
    """
    if declared and declared.strip():
        return declared.strip()
    key = (format or "").strip().lower()
    if key == "gltf":
        # The only case where the extension is load-bearing, because glTF
        # is genuinely two formats and Blender's exporter writes whichever
        # the user picked in the file dialog.
        return "model/gltf-binary" if path.lower().endswith(".glb") else "model/gltf+json"
    if key == "usd" and path.lower().endswith(".usdz"):
        return EXPORT_FORMAT_MIME["usdz"]
    mime = EXPORT_FORMAT_MIME.get(key)
    if mime is None:
        raise MimeRequiredError(
            f"Export format {format!r} has no declared media type. Pass an "
            "explicit `mime` on the operator -- the user exported this file "
            "and knows what it is; the addon does not guess."
        )
    return mime


# ---- scene introspection -------------------------------------------------

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
        return DEFAULT_BLENDER_VERSION


# ---- workflow snapshots -------------------------------------------------
# These stay here rather than moving to the SDK for the reason
# scruple_api/manifest.py gives for dropping Blender's fields from
# build_machine_manifest: "scene-specific fields like that belong in the
# adapter's `workflow` dict". This is that dict.

def build_render_workflow(
    *,
    filename: str,
    scene_name: str,
    render_engine: str,
    resolution: tuple,
    samples: Optional[int],
    camera: Optional[str],
    frame: Optional[int] = None,
    trigger: Optional[str] = None,
) -> Dict[str, Any]:
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
    if trigger:
        workflow["trigger"] = trigger
    return workflow


def build_save_workflow(
    *,
    filepath: str,
    scene_name: str,
    object_count: int,
    material_count: int,
    trigger: Optional[str] = None,
) -> Dict[str, Any]:
    workflow: Dict[str, Any] = {
        "kind": "blender_save",
        "filepath": filepath,
        "scene": scene_name,
        "object_count": int(object_count),
        "material_count": int(material_count),
    }
    if trigger:
        workflow["trigger"] = trigger
    return workflow


def build_export_workflow(
    *,
    filepath: str,
    format: str,
    scene_name: str,
    exporter_options: Optional[Dict[str, Any]] = None,
    trigger: Optional[str] = None,
) -> Dict[str, Any]:
    workflow: Dict[str, Any] = {
        "kind": "blender_export",
        "filepath": filepath,
        "format": format.lower(),
        "scene": scene_name,
    }
    if exporter_options:
        workflow["options"] = dict(exporter_options)
    if trigger:
        workflow["trigger"] = trigger
    return workflow


def host_environment() -> Dict[str, Any]:
    """The Blender-specific fields that used to be hardcoded into
    lib/manifest.py's build_machine_manifest. The SDK's is host-agnostic
    and takes these as `extra`."""
    env: Dict[str, Any] = {
        "blender_version": blender_version_string(),
        "addon": "scruple-blender",
    }
    addons = enabled_addons_list()
    if addons:
        env["enabled_addons"] = addons
    return env
