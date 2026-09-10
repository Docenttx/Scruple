"""FINDING F1-1: the add-on's tamper surface hash measures WHERE it is installed.

    python3 scripts/f1-surface-path-proof.py [INSTALLED_ADDON_DIR]

No Blender needed. `scruple_api.manifest.compute_tamper_surface_hash()` builds
its file map keyed by the path it walked:

    files[str(f)] = sha256_file(str(f))     # str(f) is the ABSOLUTE path

and hashes that map. So the same bytes, installed in two different directories,
produce two different surface hashes — and `baselines.baseline_hash` is that
number. Two users on two machines, running the identical published zip, can
never share a baseline; one user moving their Blender profile "drifts".

This is not WO-F1's doing and WO-F1 does not fix it. It surfaced because WO-F1
is the first change to move the add-on's surface hash, which forced the question
of what the number is a measurement OF. It is a measurement of the code AND the
directory, and only the first of those is what D-3 says a baseline means.

The control is in the script: the copy is compared with `diff -r` before it is
hashed, so "identical bytes" is checked rather than assumed.

⚑ It also confirms what the leaf's `baseline_hash` column IS. Run against the
add-on as WO-E7 installed it, this prints `22e97c93c1d8176d…`, which is exactly
the row in `baselines` for tenant `blender-addon-standalone`.
"""
import filecmp
import json
import os
import shutil
import subprocess
import sys
import tempfile

DEFAULT = "/mnt/corpus/scruple-desktop/.run/e7/blender-profile/extensions/user_default/scruple_blender"
ROOT = sys.argv[1] if len(sys.argv) > 1 else DEFAULT

if not os.path.isdir(ROOT):
    raise SystemExit(f"no installed add-on at {ROOT}")

# The SDK that ships inside the add-on under test, not some other copy.
sys.path.insert(0, os.path.join(ROOT, "vendor"))
from scruple_api import manifest as _manifest  # noqa: E402

# adapter/sdk.py TAMPER_SURFACE_PATHS, and `flow.ensure_attached()`'s config.
SURFACE = ("__init__.py", "adapter", "operators", "panels", "vendor")
CONFIG = {"host": "blender"}


def surface_hash(root: str) -> str:
    return _manifest.compute_tamper_surface_hash(
        integration_version=open(os.path.join(root, "VERSION")).read().strip(),
        config=CONFIG,
        code_paths=[os.path.join(root, p) for p in SURFACE],
    )


tmp = tempfile.mkdtemp(prefix="f1-surface-path-")
try:
    copy = os.path.join(tmp, os.path.basename(ROOT))
    shutil.copytree(ROOT, copy)
    diff = subprocess.run(
        ["diff", "-r", "-q", ROOT, copy], capture_output=True, text=True
    )
    out = {
        "installed_at": ROOT,
        "installed_hash": surface_hash(ROOT),
        "copied_to": copy,
        "copied_hash": surface_hash(copy),
        # CONTROL: if the copy were not byte-identical the two hashes would be
        # allowed to differ and this would prove nothing.
        "bytes_identical": diff.returncode == 0 and not diff.stdout.strip(),
        "diff_output": diff.stdout.strip() or None,
    }
    out["hashes_differ"] = out["installed_hash"] != out["copied_hash"]
    out["verdict"] = (
        "PATH-SENSITIVE: identical bytes, two directories, two baselines"
        if out["bytes_identical"] and out["hashes_differ"]
        else "not reproduced"
    )
    print(json.dumps(out, indent=1))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
