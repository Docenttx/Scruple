import bpy
bpy.ops.wm.open_mainfile(filepath="/data/oss-study/cad/blendlab/B1.blend")
bpy.ops.wm.save_as_mainfile(filepath="/data/oss-study/cad/blendlab/S0.blend", copy=True)
o=bpy.data.objects[0]; o.location.x += 0.001
bpy.ops.wm.save_as_mainfile(filepath="/data/oss-study/cad/blendlab/S1.blend", copy=True)
for m in bpy.data.objects[0].modifiers:
    if m.type=='SUBSURF': m.levels=3
bpy.ops.wm.save_as_mainfile(filepath="/data/oss-study/cad/blendlab/S2.blend", copy=True)
o.name = o.name  # no-op
bpy.ops.wm.save_as_mainfile(filepath="/data/oss-study/cad/blendlab/S3.blend", copy=True)
