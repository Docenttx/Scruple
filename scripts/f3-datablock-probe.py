"""Run INSIDE Blender: does a PACKED image datablock's bytes re-hash to the
source file on disk?

WO-F3's whole design rests on this. The declared field names imported
datablocks and their DIGESTS, and control (d) requires that digest to match a
Desktop Studio leaf's `content_hash` for the same artifact — which is the
sha256 of the file ComfyUI wrote. If Blender re-encoded the pixels on pack(),
the digest would be of something nobody else ever held and the whole
composition claim would be false while looking fine.

Measured, not assumed:
  * sha256 of the file on disk, taken by this script before Blender loads it;
  * sha256 of `img.packed_file.data` after pack();
  * sha256 of the file read back through bpy.path.abspath for an UNPACKED
    image, which is the other of the two paths the enumerator has to take;
  * and what Blender reports for a datablock whose file has been DELETED —
    control (b)'s case.

  blender --background --python scripts/f3-datablock-probe.py -- --work DIR --image PNG
"""

import hashlib
import json
import os
import sys

import bpy

MARK_OPEN = "<<<F3_PROBE"
MARK_CLOSE = "F3_PROBE>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return {args[i].lstrip("-"): args[i + 1] for i in range(0, len(args) - 1, 2)}


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()


def main():
    a = argv()
    work = a["work"]
    os.makedirs(work, exist_ok=True)
    src = a["image"]
    out = {"blender": ".".join(str(x) for x in bpy.app.version), "source": src}
    out["sha256_of_file_on_disk"] = sha_file(src)
    out["bytes_on_disk"] = os.path.getsize(src)

    # --- 1. packed ---------------------------------------------------------
    img = bpy.data.images.load(src)
    img.name = "packed-import"
    img.pack()
    data = bytes(img.packed_file.data)
    out["packed"] = {
        "source_enum": img.source,
        "packed_size": img.packed_file.size,
        "len_data": len(data),
        "sha256_of_packed_data": hashlib.sha256(data).hexdigest(),
        "filepath": img.filepath,
        "abspath": bpy.path.abspath(img.filepath),
    }
    out["packed"]["matches_file_on_disk"] = (
        out["packed"]["sha256_of_packed_data"] == out["sha256_of_file_on_disk"]
    )

    # --- 2. unpacked, read through abspath ---------------------------------
    copy = os.path.join(work, "unpacked-copy.png")
    with open(src, "rb") as r, open(copy, "wb") as w:
        w.write(r.read())
    img2 = bpy.data.images.load(copy)
    img2.name = "unpacked-import"
    p2 = bpy.path.abspath(img2.filepath)
    out["unpacked"] = {
        "source_enum": img2.source,
        "filepath": img2.filepath,
        "abspath": p2,
        "exists": os.path.exists(p2),
        "packed_file": img2.packed_file is not None,
        "sha256_via_abspath": sha_file(p2) if os.path.exists(p2) else None,
    }
    out["unpacked"]["matches_file_on_disk"] = (
        out["unpacked"]["sha256_via_abspath"] == out["sha256_of_file_on_disk"]
    )

    # --- 3. the file goes away — control (b)'s case ------------------------
    gone = os.path.join(work, "will-be-deleted.png")
    with open(src, "rb") as r, open(gone, "wb") as w:
        w.write(r.read())
    img3 = bpy.data.images.load(gone)
    img3.name = "vanished-import"
    os.remove(gone)
    p3 = bpy.path.abspath(img3.filepath)
    out["deleted"] = {
        "source_enum": img3.source,
        "abspath": p3,
        "exists": os.path.exists(p3),
        "packed_file": img3.packed_file is not None,
        "has_data": bool(img3.has_data),
        "size": list(img3.size),
    }
    try:
        with open(p3, "rb") as f:
            f.read(1)
        out["deleted"]["read_error"] = None
    except OSError as e:
        out["deleted"]["read_error"] = type(e).__name__

    # --- 4. a GENERATED image is not an import ----------------------------
    img4 = bpy.data.images.new("generated-here", 8, 8)
    out["generated"] = {
        "source_enum": img4.source,
        "filepath": img4.filepath,
        "packed_file": img4.packed_file is not None,
    }

    # --- 5. what bpy.data holds, and what a render adds -------------------
    out["images_before_render"] = sorted(i.name for i in bpy.data.images)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 1
    sc.render.resolution_x = sc.render.resolution_y = 8
    sc.render.filepath = os.path.join(work, "probe-render")
    bpy.ops.render.render(write_still=True)
    out["images_after_render"] = sorted(i.name for i in bpy.data.images)
    out["render_result_source"] = {
        i.name: i.source for i in bpy.data.images if i.name not in out["images_before_render"]
    }

    sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(out, indent=1, default=str) + "\n" + MARK_CLOSE + "\n")
    sys.stdout.flush()


main()
