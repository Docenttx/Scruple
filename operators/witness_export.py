"""Manual export witness -- user picks an already-exported file.

Blender's export operators (bpy.ops.export_scene.gltf, .fbx, .obj,
export_mesh.usd) are individual invocations rather than a hookable
`export_post` list. Real auto-wrapping would subclass each importer/
exporter and re-register; that is a follow-up. Until then this operator
is what the user invokes from the Scruple N-panel after running the
built-in exporter.

The `mime` field is new and it is the reason "Other" is still offered.
Property 1 (MIME is declared, never guessed) means the addon cannot
accept an arbitrary file and shrug -- so a known format resolves from
adapter/scene.py's table and "Other" requires the user to say what they
exported.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import flow as _wf
from adapter import sdk as _sdk
from operators.witness import report_for


if bpy is not None:

    FORMAT_ITEMS = [
        ("gltf", "glTF (.glb/.gltf)", "glTF 2.0"),
        ("fbx", "FBX", "Autodesk FBX"),
        ("obj", "OBJ", "Wavefront OBJ"),
        ("usd", "USD", "Universal Scene Description"),
        ("other", "Other", "Any other exported file -- requires an explicit MIME type"),
    ]

    class SCRUPLE_OT_witness_export(bpy.types.Operator):
        bl_idname = "scruple.witness_export"
        bl_label = "Witness this export"
        bl_description = "Hash a just-exported file and post it as a Scruple leaf"

        filepath: bpy.props.StringProperty(subtype="FILE_PATH")
        format: bpy.props.EnumProperty(items=FORMAT_ITEMS, default="gltf")
        mime: bpy.props.StringProperty(
            name="MIME type",
            description="Required for format 'Other'. The addon does not guess a type from the extension.",
            default="",
        )

        def invoke(self, context, event):
            return context.window_manager.fileselect_add(self) if hasattr(context.window_manager, "fileselect_add") else self.execute(context)

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            path = self.filepath.strip()
            if not path:
                self.report({"ERROR"}, "No file selected.")
                return {"CANCELLED"}
            try:
                outcome = _wf.witness_export(
                    client, context.scene, path, format=self.format,
                    mime=(self.mime or None), trigger="manual_export",
                )
            except Exception as e:
                self.report({"ERROR"}, f"Witness failed: {e}")
                return {"CANCELLED"}
            if outcome is None:
                self.report({"WARNING"}, "No file at that path.")
                return {"CANCELLED"}
            level, message = report_for(outcome)
            self.report(level, message)
            return {"FINISHED"} if outcome.witnessed or outcome.queued else {"CANCELLED"}

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
