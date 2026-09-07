#!/usr/bin/env python3
"""Check vendor/ against vendor/VENDOR.json, and against the source tree
when that tree is on this machine.

Three ways a vendored copy goes wrong, all checked here:
  1. a vendored file was edited in place  -> hash mismatch
  2. a vendored file was deleted          -> missing
  3. a file appeared that was never vendored -> unlisted

Exits 1 with a numbered list. Used by build/build_addon.sh so a zip is
never cut from a vendor tree that no longer matches its own manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

VENDOR_DIR = os.environ.get("SCRUPLE_VENDOR_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor"
)
MANIFEST = os.path.join(VENDOR_DIR, "VENDOR.json")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def present_files(vendor_dir: str):
    out = set()
    for dirpath, dirnames, filenames in os.walk(vendor_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if fn.endswith(".pyc") or fn == "VENDOR.json":
                continue
            out.add(os.path.relpath(os.path.join(dirpath, fn), vendor_dir))
    return out


def verify(vendor_dir: str = VENDOR_DIR):
    errors = []
    manifest_path = os.path.join(vendor_dir, "VENDOR.json")
    if not os.path.exists(manifest_path):
        return [f"no manifest at {manifest_path}"]
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    listed = manifest.get("files", {})
    if not listed:
        errors.append("VENDOR.json lists no files")

    for rel, expected in sorted(listed.items()):
        path = os.path.join(vendor_dir, rel)
        if not os.path.exists(path):
            errors.append(f"{rel}: listed in VENDOR.json but missing on disk")
            continue
        actual = sha256_file(path)
        if actual != expected:
            errors.append(f"{rel}: sha256 {actual[:12]} != manifest {expected[:12]} (edited in place)")

    for rel in sorted(present_files(vendor_dir) - set(listed)):
        errors.append(f"{rel}: present in vendor/ but not listed in VENDOR.json")

    # Drift against the source tree, when it is reachable. This is a
    # separate failure from the two above: vendor/ can be internally
    # consistent and still be an old copy.
    source_root = os.environ.get("SCRUPLE_WEB_ROOT") or manifest.get("source_repo") or ""
    if source_root and os.path.isdir(source_root):
        for pkg in manifest.get("packages", []):
            src = os.path.join(source_root, pkg["source_path"])
            if not os.path.isdir(src):
                continue
            for rel, expected in sorted(listed.items()):
                if not rel.startswith(pkg["package"] + os.sep):
                    continue
                sub = rel.split(os.sep, 1)[1]
                spath = os.path.join(src, sub)
                if not os.path.exists(spath):
                    errors.append(f"{rel}: no longer exists in source {pkg['source_path']}")
                elif sha256_file(spath) != expected:
                    errors.append(f"{rel}: source has changed since vendoring -- re-run build/vendor_sdk.sh")
    return errors


if __name__ == "__main__":
    problems = verify()
    if problems:
        print(f"vendor verification FAILED ({len(problems)} problem(s)):", file=sys.stderr)
        for i, p in enumerate(problems, 1):
            print(f"  {i}. {p}", file=sys.stderr)
        sys.exit(1)
    print("vendor: OK")
