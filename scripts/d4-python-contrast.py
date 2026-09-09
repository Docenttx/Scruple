#!/usr/bin/env python3
"""THE CONTROL, RED BEFORE THE CHANGE.

WO-D4 says `modal/scruple_runner.py` "already does this ... the code exists, it
just needs somewhere to stand". It does — and standing it up unchanged would
carry two defects across, so this script runs THE ACTUAL FUNCTIONS out of the
server repo, over the SAME model store the new surface is gated on, and prints
what each one recorded.

The functions are not retyped. They are sliced out of
/data/scruple-web/modal/scruple_runner.py by source text and exec'd here,
because importing the module would require `modal` and a deployed app. ONE
substitution is made and it is the only one: the literal "/opt/ComfyUI/models",
which is the Modal volume mount point, becomes the model root passed on the
command line. Nothing else is touched — the `if fp is not None` and the
`"mtime": st.st_mtime` are exactly as they ship.

WHAT IT DEMONSTRATES, and both are things the new surface had to change:

  1. A MODEL THE WORKFLOW NAMED AND THE STORE DOES NOT HOLD IS DROPPED.
     `_hash_workflow_models` ends `fp = _fingerprint_file(rel); if fp is not
     None: fingerprints[rel] = fp`. A run that loaded no LoRA and a run whose
     LoRA was deleted before anyone looked produce the SAME manifest, and
     therefore the same model_fingerprints_hash. The absence is not weaker
     evidence; it is no evidence, and it is indistinguishable from the file
     never having been mentioned.

  2. THE RECORD COMMITS `mtime`, WHICH IS NOT A PROPERTY OF THE BYTES.
     `touch` the file and the fingerprint changes while the weights do not.
     lib/leaf/hashes.ts already strips it back out on the server with the
     argument in full — "one of the five headline hashes was not recomputable
     by anyone holding the model" — so what ships is a record whose own
     producer's hash function has to defend against it.

Usage:  python3 scripts/d4-python-contrast.py <model-root> [<leaf-manifest.json>]
"""
import json
import os
import re
import shutil
import sys
import tempfile

RUNNER = os.environ.get("SCRUPLE_RUNNER_PY", "/data/scruple-web/modal/scruple_runner.py")

model_root = os.path.abspath(sys.argv[1])
leaf_manifest_path = sys.argv[2] if len(sys.argv) > 2 else None
rc = 0


def fail(msg):
    global rc
    print(f"   FAIL — {msg}")
    rc = 1


src = open(RUNNER).read()


def slice_defs(text, names):
    """Take each top-level `def <name>` (or assignment) block verbatim."""
    out = []
    for name in names:
        m = re.search(rf"^(def {re.escape(name)}\(|{re.escape(name)}(: [^=]+)? = )", text, re.M)
        if not m:
            raise SystemExit(f"could not find {name} in {RUNNER}")
        start = m.start()
        rest = text[start:]
        # up to the next top-level statement
        nxt = re.search(r"^(?=\S)", rest[1:], re.M)
        end = len(rest)
        pos = 1
        while True:
            nxt = re.search(r"\n(?=[^\s#])", rest[pos:])
            if not nxt:
                break
            cand = pos + nxt.start() + 1
            # keep going while the block is still the same def (decorators etc.)
            if rest[cand:].startswith(("def ", "@")) or re.match(r"^[A-Za-z_]", rest[cand:]):
                end = cand
                break
            pos = cand + 1
        out.append(rest[:end])
    return "\n".join(out)

# The sliced blocks use `Dict`, `Any`, `Optional` and `os`/`json` from the
# module's own imports. Providing them is not a modification of the code — it
# is the import block the slice left behind.
from typing import Any, Dict, Optional  # noqa: E402
ns = {"os": os, "json": json, "Dict": Dict, "Any": Any, "Optional": Optional}
code = slice_defs(src, ["MODEL_LOADERS", "MODEL_EXTS", "_MODEL_HASH_CACHE",
                        "_safetensors_header_hash", "_fingerprint_file", "_hash_workflow_models"])
code = code.replace('"/opt/ComfyUI/models"', json.dumps(model_root))
exec(compile(code, "<scruple_runner.py: sliced>", "exec"), ns)

present = None
for sub in ("upscale_models", "loras", "checkpoints"):
    d = os.path.join(model_root, sub)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith(".safetensors"):
                present = (sub, f)
                break
    if present:
        break
if not present:
    raise SystemExit(f"no model file under {model_root}; run the scenario once first")
subdir, filename = present

# A workflow that names TWO models: one the store holds, one it does not.
workflow = {
    "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": filename}},
    "5": {"class_type": "LoraLoader", "inputs": {"lora_name": "client-proprietary.safetensors"}},
}

print("── modal/scruple_runner.py, over this model store ──")
print(f"   model root  : {model_root}")
print(f"   workflow    : names {subdir}/{filename} (present) and loras/client-proprietary.safetensors (absent)")
py_manifest = ns["_hash_workflow_models"](workflow)
print(f"   entries     : {len(py_manifest)}  {sorted(py_manifest)}")

# ---- DEFECT 1
if "loras/client-proprietary.safetensors" in py_manifest:
    fail("the runner recorded the absent model; the contrast cannot be shown")
else:
    print("   DEFECT 1 (red): the absent model is DROPPED — 2 referenced, 1 recorded.")
    print("                   a run that used no LoRA is indistinguishable from this one.")

# ---- DEFECT 2
full = os.path.join(model_root, subdir, filename)
before = ns["_fingerprint_file"](f"{subdir}/{filename}")
tmp = tempfile.mkdtemp()
copy = os.path.join(tmp, filename)
shutil.copy2(full, copy)
os.utime(full, (0, 0))          # the bytes do not move; only the timestamp does
ns["_MODEL_HASH_CACHE"].clear()  # a stat-keyed cache would hide the point
after = ns["_fingerprint_file"](f"{subdir}/{filename}")
shutil.copystat(copy, full)     # put the mtime back
shutil.rmtree(tmp, ignore_errors=True)

if before["content_hash"] != after["content_hash"]:
    fail("touching the file changed its content hash; the fixture moved under us")
elif before == after:
    fail("the runner's record is unchanged by mtime; the contrast cannot be shown")
else:
    print(f"   DEFECT 2 (red): identical bytes ({before['content_hash'][:12]}), record CHANGED —")
    print(f"                   mtime {before['mtime']} → {after['mtime']} is inside it.")

# ---- and what the new surface put on the leaf, over the same store
if leaf_manifest_path and os.path.exists(leaf_manifest_path):
    leaf = json.load(open(leaf_manifest_path))
    print("\n── app/comfy, on the leaf, over the same store ──")
    for k in sorted(leaf):
        e = leaf[k]
        print(f"   {k:<48} {e['state']:<14} {str(e['content_hash'])[:12]:<14} via {e['resolution']}")
    print("\n── the contrast ──")
    print(f"   runner   : {len(py_manifest)} entries; a referenced-and-missing model has no row")
    print(f"   app/comfy: {len(leaf)} entries; every reference has a row and a state")
    if any("mtime" in e for e in leaf.values()):
        fail("the new manifest carries mtime — the digest is not recomputable by a holder of the weights")
    else:
        print("   and no entry carries a timestamp, so anyone holding the weights recomputes the digest.")

sys.exit(rc)
