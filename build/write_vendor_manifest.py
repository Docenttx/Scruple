#!/usr/bin/env python3
"""Write vendor/VENDOR.json after build/vendor_sdk.sh has copied the tree.

Records, per vendored package: the source repo path, the source commit,
whether that commit's working tree was dirty in the vendored paths at
copy time, and the sha256 of every file copied. The per-file hashes are
what make `--verify` able to say "this vendored copy has been edited in
place" rather than only "a directory exists".
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time

VENDOR_DIR = os.environ["SCRUPLE_VENDOR_DIR"]
SOURCE_ROOT = os.environ["SCRUPLE_SOURCE_ROOT"]
SOURCE_COMMIT = os.environ["SCRUPLE_SOURCE_COMMIT"]
SOURCE_DIRTY = os.environ["SCRUPLE_SOURCE_DIRTY"] == "true"
PACKAGES = [spec.split(":", 1) for spec in os.environ["SCRUPLE_PACKAGES"].split()]


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(pkg_dir: str):
    for dirpath, dirnames, filenames in os.walk(pkg_dir):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        for fn in sorted(filenames):
            if fn.endswith(".pyc"):
                continue
            yield os.path.join(dirpath, fn)


def commit_subject() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", SOURCE_ROOT, "log", "-1", "--format=%s", SOURCE_COMMIT],
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, OSError):
        return ""


files = {}
packages = []
for name, rel in PACKAGES:
    pkg_dir = os.path.join(VENDOR_DIR, name)
    count = 0
    for path in walk(pkg_dir):
        files[os.path.relpath(path, VENDOR_DIR)] = sha256_file(path)
        count += 1
    packages.append({"package": name, "source_path": rel, "file_count": count})

manifest = {
    "vendored_by": "build/vendor_sdk.sh",
    "vendored_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "why_vendored": (
        "A Blender addon cannot pip install; the SDK ships inside the zip. "
        "Both packages are pure standard library, so this is cp -r, not a "
        "dependency resolver."
    ),
    "source_repo": SOURCE_ROOT,
    "source_commit": SOURCE_COMMIT,
    "source_commit_subject": commit_subject(),
    "source_tree_dirty_at_copy": SOURCE_DIRTY,
    "packages": packages,
    "files": dict(sorted(files.items())),
}

out = os.path.join(VENDOR_DIR, "VENDOR.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, sort_keys=False)
    f.write("\n")
print(f"vendor_sdk: wrote {out} ({len(files)} files)")
