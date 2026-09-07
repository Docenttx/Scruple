"""Minimal bpy surface for pytest.

We mirror only the APIs the addon actually calls. When a new call gets
added to the addon, add its stub here rather than reaching into real
Blender's Python.

Pattern lifted directly from /data/scruple-fusion/lib/fusion_mocks.py —
which trades depth for maintainability. Every deviation is a note in
comments so the diff to real bpy is auditable.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


# ------------------------------------------------------------------ handlers

class HandlerList(list):
    """Real bpy.app.handlers.<name> is a Python list; identical semantics."""


class AppHandlers:
    def __init__(self) -> None:
        self.render_complete = HandlerList()
        self.render_write = HandlerList()
        self.save_post = HandlerList()
        self.load_post = HandlerList()
        self.depsgraph_update_post = HandlerList()


class App:
    def __init__(self) -> None:
        self.handlers = AppHandlers()
        self.version = (4, 2, 0)


# ------------------------------------------------------------------ data

class BpyData:
    def __init__(self) -> None:
        self.filepath: str = ""
        self.materials: List[Any] = []


# ------------------------------------------------------------------ scene

@dataclass
class ImageFormatSettings:
    """bpy.types.ImageFormatSettings. `file_format` is Blender's own enum
    for the format it encoded -- the addon declares MIME from this rather
    than guessing from the filename (adapter/scene.py)."""
    file_format: str = "PNG"


@dataclass
class FFmpegSettings:
    """bpy.types.FFmpegSettings. Only `format` matters here: it is the
    container, and it is the second step of resolving a MIME type when
    file_format is FFMPEG."""
    format: str = "MPEG4"


@dataclass
class RenderSettings:
    filepath: str = ""
    resolution_x: int = 1920
    resolution_y: int = 1080
    engine: str = "CYCLES"
    image_settings: ImageFormatSettings = field(default_factory=ImageFormatSettings)
    ffmpeg: FFmpegSettings = field(default_factory=FFmpegSettings)
    # Real bpy exposes both. `file_extension` is read-only and
    # format-aware -- Blender reports ".jpg" for JPEG, not ".jpeg" --
    # so the addon asks Blender rather than deriving it.
    use_file_extension: bool = True
    file_extension: str = ".png"


@dataclass
class CyclesSettings:
    samples: int = 128


@dataclass
class SceneObjectRef:
    name: str


@dataclass
class SceneObjectCollection:
    _items: List[Any] = field(default_factory=list)

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)


@dataclass
class Camera:
    name: str = "Camera"


@dataclass
class Scene:
    name: str = "Scene"
    frame_current: int = 1
    render: RenderSettings = field(default_factory=RenderSettings)
    cycles: CyclesSettings = field(default_factory=CyclesSettings)
    camera: Camera = field(default_factory=Camera)
    objects: SceneObjectCollection = field(default_factory=SceneObjectCollection)


# ------------------------------------------------------------------ context / preferences

class AddonPref:
    def __init__(self, module: str, preferences: Any) -> None:
        self.module = module
        self.preferences = preferences


class AddonRegistry:
    def __init__(self) -> None:
        self._items: Dict[str, AddonPref] = {}

    def __contains__(self, key: str) -> bool:
        return key in self._items

    def keys(self):
        return list(self._items.keys())

    def get(self, key: str) -> Optional[AddonPref]:
        return self._items.get(key)

    def register(self, module: str, preferences: Any) -> AddonPref:
        p = AddonPref(module, preferences)
        self._items[module] = p
        return p


class Preferences:
    def __init__(self) -> None:
        self.addons = AddonRegistry()


class Context:
    def __init__(self) -> None:
        self.scene = Scene()
        self.preferences = Preferences()
        self.window_manager = WindowManager()


# ------------------------------------------------------------------ operators

class OperatorBase:
    """Stand-in for bpy.types.Operator.

    Subclasses can override execute/invoke and inspect self.report calls
    via reports_recorded on the surrogate class instance.
    """

    bl_idname: str = ""
    bl_label: str = ""
    bl_description: str = ""

    def __init__(self) -> None:
        self.reports_recorded: List = []

    def report(self, level, message: str) -> None:
        self.reports_recorded.append((set(level), message))


class PanelBase:
    bl_space_type: str = "VIEW_3D"
    bl_region_type: str = "UI"
    bl_category: str = ""
    bl_label: str = ""


class AddonPreferencesBase:
    bl_idname: str = ""


# ------------------------------------------------------------------ window manager

class WindowManager:
    def __init__(self) -> None:
        self.confirm_answer_stack: List[bool] = []
        self.confirm_messages: List[str] = []

    def invoke_confirm(self, operator: Any, event: Any, *, message: str = "", **kwargs: Any):
        self.confirm_messages.append(message or getattr(operator, "bl_label", ""))
        if self.confirm_answer_stack:
            answered = self.confirm_answer_stack.pop(0)
        else:
            answered = True
        if answered:
            return operator.execute(self._make_ctx())
        return {"CANCELLED"}

    def invoke_props_dialog(self, operator: Any, *args, **kwargs):
        message = getattr(operator, "_message", None) or getattr(operator, "bl_label", "")
        self.confirm_messages.append(message)
        if self.confirm_answer_stack:
            answered = self.confirm_answer_stack.pop(0)
        else:
            answered = True
        if answered:
            return operator.execute(self._make_ctx())
        return {"CANCELLED"}

    def _make_ctx(self) -> "Context":
        return _CTX


# ------------------------------------------------------------------ utils / path

class BpyUtils:
    _registered_classes: List[type] = []

    @classmethod
    def register_class(cls, klass: type) -> None:
        cls._registered_classes.append(klass)

    @classmethod
    def unregister_class(cls, klass: type) -> None:
        try:
            cls._registered_classes.remove(klass)
        except ValueError:
            pass


class BpyPath:
    @staticmethod
    def abspath(p: str) -> str:
        if p.startswith("//"):
            return os.path.abspath(p[2:])
        return os.path.abspath(os.path.expanduser(p))


# ------------------------------------------------------------------ props / types

class _PropStub:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class Props:
    @staticmethod
    def StringProperty(**kw): return _PropStub(**kw)
    @staticmethod
    def BoolProperty(**kw): return _PropStub(**kw)
    @staticmethod
    def IntProperty(**kw): return _PropStub(**kw)
    @staticmethod
    def EnumProperty(**kw): return _PropStub(**kw)
    @staticmethod
    def FloatProperty(**kw): return _PropStub(**kw)


class Types:
    Operator = OperatorBase
    Panel = PanelBase
    AddonPreferences = AddonPreferencesBase


# ------------------------------------------------------------------ module assembly

app = App()
data = BpyData()
_CTX = Context()


def context_get():
    return _CTX


class _BpyModule:
    """Shape mimics `bpy` module namespace."""
    def __init__(self) -> None:
        self.app = app
        self.data = data
        self.utils = BpyUtils
        self.path = BpyPath
        self.props = Props
        self.types = Types

    @property
    def context(self):
        return _CTX


def install(monkeypatch=None):
    """Inject the mock as `bpy` in sys.modules. Idempotent."""
    module = _BpyModule()
    sys.modules["bpy"] = module
    return module


def reset():
    """Restore mock state between tests."""
    global _CTX
    app.handlers = AppHandlers()
    data.filepath = ""
    data.materials = []
    _CTX = Context()
    BpyUtils._registered_classes = []


def reset_context_scene(scene: Scene) -> None:
    _CTX.scene = scene
