"""Manual export witness — user picks an already-exported file.

Blender's export operators (bpy.ops.export_scene.gltf, .fbx, .obj,
export_mesh.usd) are individual invocations rather than a hookable
`export_post` list. Real auto-wrapping would subclass each importer/
exporter and re-register; that is a follow-up. Until then this
operator is what the user invokes from the Scruple N-panel after
running the built-in exporter.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from lib import scruple_client as _client_mod
from lib import witness_flow as _wf


if bpy is not None:

    FORMAT_ITEMS = [
        ("gltf", "glTF (.glb/.gltf)", "glTF 2.0"),
        ("fbx", "FBX", "Autodesk FBX"),
        ("obj", "OBJ", "Wavefront OBJ"),
        ("usd", "USD", "Universal Scene Description"),
        ("other", "Other", "Any other exported file"),
    ]

    class SCRUPLE_OT_witness_export(bpy.types.Operator):
        bl_idname = "scruple.witness_export"
        bl_label = "Witness this export"
        bl_description = "Hash a just-exported file and post it as a Scruple leaf"

        filepath: bpy.props.StringProperty(subtype="FILE_PATH")
        format: bpy.props.EnumProperty(items=FORMAT_ITEMS, default="gltf")

        def invoke(self, context, event):
            return context.window_manager.fileselect_add(self) if hasattr(context.window_manager, "fileselect_add") else self.execute(context)

        def execute(self, context):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            path = self.filepath.strip()
            if not path:
                self.report({"ERROR"}, "No file selected.")
                return {"CANCELLED"}
            try:
                resp = _wf.witness_export(
                    client, context.scene, path, format=self.format, trigger="manual_export",
                )
            except Exception as e:
                self.report({"ERROR"}, f"Witness failed: {e}")
                return {"CANCELLED"}
            if resp is None:
                self.report({"WARNING"}, "No file at that path.")
                return {"CANCELLED"}
            leaf = resp.get("leafHash") or resp.get("leaf_hash") or ""
            self.report({"INFO"}, f"Export witnessed. leaf={leaf[:12]}...")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_witness_export,)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)

    def unregister():
        for cls in reversed(_CLASSES):
            try:
                bpy.utils.unregister_class(cls)
            except Exception:
                pass

else:

    def register():
        pass

    def unregister():
        pass
