"""In-container machine manifest — WO-B1 (2026-07-13).

Walks /opt/ComfyUI/custom_nodes/, resolves each pack's git commit SHA,
and hashes the pack directory bytes. Produces a canonical machine
manifest whose hash pins the toolchain the container actually ran
(not just what was declared in `config/default-machine-manifest.json`).

The resulting `machine_manifest_hash` is returned to the web backend
by every `run_workflow` invocation; the web-side ingest layer folds it
into the leaf (v2.4 first-class field). Every downstream verifier that
walks a receipt now sees a hash that mechanically pins:

  - ComfyUI version by tag string (from git rev-parse of /opt/ComfyUI)
  - Every custom-node pack directory name
  - The immutable git commit SHA of each pack
  - A hash of the pack's file contents (defense-in-depth against
    post-clone tampering)

This replaces the pre-B1 story where machine_manifest_hash only pinned
the declarative manifest descriptor (mutable git refs like 'main' or
'v1.3.6', with commit_sha=null everywhere).

Cross-language canonicalization must match services/witness/canonical_workflow.py
and lib/canvas/manifest.ts: recursive sort_keys, no whitespace.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from typing import Any, Dict, List, Optional

COMFYUI_DIR = "/opt/ComfyUI"
CUSTOM_NODES_DIR = "/opt/ComfyUI/custom_nodes"


def _canonicalize(obj: Any) -> str:
    """Sorted-key, whitespace-free JSON — parity with the TS/Py twins."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _git_rev_parse(cwd: str) -> Optional[str]:
    """Return the 40-hex HEAD commit SHA for a git repo at cwd, or None."""
    if not os.path.isdir(os.path.join(cwd, ".git")):
        return None
    try:
        r = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            sha = r.stdout.strip()
            if len(sha) == 40 and all(c in "0123456789abcdef" for c in sha):
                return sha
    except Exception:
        return None
    return None


def _git_describe_tag(cwd: str) -> Optional[str]:
    """Return the closest tag if any (e.g. 'v0.18.5'), else None."""
    try:
        r = subprocess.run(
            ["git", "-C", cwd, "describe", "--tags", "--always"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            return r.stdout.strip() or None
    except Exception:
        return None
    return None


def _hash_dir_contents(root: str) -> str:
    """Return sha256 of a canonical listing of every non-dotdir file under
    `root`. Sorted paths + sha256 per file + size — a lightweight
    tarball-like fingerprint that catches post-clone edits without pulling
    in an actual tar dependency. Skips .git/, __pycache__/, and *.pyc
    (build-time artifacts that vary across runs)."""
    entries: List[bytes] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune noise
        dirnames[:] = sorted(d for d in dirnames if d not in (".git", "__pycache__", "node_modules"))
        for fn in sorted(filenames):
            if fn.endswith((".pyc", ".pyo")):
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
                with open(full, "rb") as fh:
                    fh_hash = hashlib.sha256(fh.read()).hexdigest()
                rel = os.path.relpath(full, root)
                entries.append(f"{rel}\t{fh_hash}\t{st.st_size}\n".encode("utf-8"))
            except Exception as e:
                # If a file becomes unreadable mid-walk, log its path but
                # keep the hash deterministic by folding the error string in.
                rel = os.path.relpath(full, root)
                entries.append(f"{rel}\t<unreadable:{type(e).__name__}>\n".encode("utf-8"))
    h = hashlib.sha256()
    for e in entries:
        h.update(e)
    return h.hexdigest()


def enumerate_custom_nodes(custom_nodes_dir: str = CUSTOM_NODES_DIR) -> List[Dict[str, Any]]:
    """Walk each subdirectory under custom_nodes/ and return:
        {pack, commit_sha, contents_hash}
    ordered by pack name (deterministic)."""
    if not os.path.isdir(custom_nodes_dir):
        return []
    packs: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(custom_nodes_dir)):
        full = os.path.join(custom_nodes_dir, name)
        if not os.path.isdir(full):
            continue
        commit_sha = _git_rev_parse(full)
        contents_hash = _hash_dir_contents(full)
        packs.append({
            "pack": name,
            "commit_sha": commit_sha,
            "contents_hash": contents_hash,
        })
    return packs


def container_machine_manifest(
    comfyui_dir: str = COMFYUI_DIR,
    custom_nodes_dir: str = CUSTOM_NODES_DIR,
) -> Dict[str, Any]:
    """Build the canonical machine manifest for THIS container.

    Shape:
        {
          "comfyui_version":      "v0.18.5" | commit_sha | "unknown",
          "comfyui_commit_sha":   "<40-hex>" | null,
          "custom_nodes": [
            {"pack": "...", "commit_sha": "...", "contents_hash": "..."},
            ...
          ]
        }
    """
    return {
        "comfyui_version": _git_describe_tag(comfyui_dir) or "unknown",
        "comfyui_commit_sha": _git_rev_parse(comfyui_dir),
        "custom_nodes": enumerate_custom_nodes(custom_nodes_dir),
    }


def container_machine_manifest_hash(
    comfyui_dir: str = COMFYUI_DIR,
    custom_nodes_dir: str = CUSTOM_NODES_DIR,
) -> str:
    """SHA-256 hex of the canonical machine manifest. Bare 64-hex."""
    manifest = container_machine_manifest(comfyui_dir, custom_nodes_dir)
    return _sha256_hex(_canonicalize(manifest).encode("utf-8"))


# Container lifetime cache — same directories → same hash every time within
# a warm container. Cleared automatically on restart when a rebuild would
# have changed the pack set anyway.
_CACHED: Optional[Dict[str, Any]] = None


def cached_container_manifest() -> Dict[str, Any]:
    """Cached form for the runner's hot path. Returns {manifest, hash}."""
    global _CACHED
    if _CACHED is None:
        m = container_machine_manifest()
        _CACHED = {
            "manifest": m,
            "hash": _sha256_hex(_canonicalize(m).encode("utf-8")),
        }
    return _CACHED
