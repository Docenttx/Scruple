"""WO-B2's gate: the SDK is the implementation, and there is only one.

The gate has three parts and each has a control that must NOT fire:

  1. The `scruple_host_sdk` imported at runtime is the vendored copy
     inside this repository -- not a pip install, not the source tree in
     /data/scruple-web. Control: the same assertion stated as "does not
     resolve outside the addon root", which fails if the vendoring is
     bypassed by a sys.path that happens to have the source tree first.

  2. The addon's own call sites reach the SDK's objects, not lookalikes.
     Asserted by identity (`is`), not by name -- two modules can both
     export a `QueueStore` and only one of them can be the one the
     Client actually writes through.

  3. The old duplicate implementation is DELETED, not orphaned. Control:
     `test_both_implementations_cannot_be_importable`, which fails if
     `lib` is importable at all, and
     `test_no_second_implementation_of_an_sdk_module_exists_in_the_tree`,
     which greps the working tree for the class and function definitions
     that used to be duplicated. Restore any of them -- as `lib/`, as
     `adapter/scruple_client.py`, as anything -- and this file goes red.

Plus the vendoring itself: VENDOR.json's per-file hashes must match what
is on disk, so a vendored copy edited in place is caught here and not in
a user's Blender.
"""

from __future__ import annotations

import ast
import importlib
import json
import os
import re
import subprocess
import sys

import pytest

import adapter
from adapter import sdk as _sdk

import scruple_api
import scruple_host_sdk

ROOT = adapter.ADDON_ROOT
VENDOR = adapter.VENDOR_DIR

#: Directories that are not the addon's source: build output, the
#: vendored SDK itself, and git/pytest scratch.
_SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", "vendor", "dist", "build", "docs", "tests"}


def _source_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


# ---- 1. the SDK actually imported is the vendored one -------------------

def test_the_sdk_imported_at_runtime_is_the_vendored_copy():
    assert _sdk.sdk_is_vendored(), (
        f"scruple_host_sdk resolved to {_sdk.sdk_module_file()}, "
        f"which is not inside {VENDOR}"
    )
    assert os.path.abspath(scruple_api.__file__).startswith(os.path.join(VENDOR, ""))


def test_the_sdk_does_not_resolve_to_the_server_source_tree():
    """The control. The source packages live in /data/scruple-web; if the
    addon is importing those, the zip it ships is not what was tested."""
    for module in (scruple_host_sdk, scruple_api):
        path = os.path.abspath(module.__file__)
        assert path.startswith(os.path.join(ROOT, "")), f"{module.__name__} is outside the addon: {path}"
        assert "/packages/" not in path, f"{module.__name__} resolved to the source tree: {path}"


def test_vendor_is_ahead_of_site_packages_on_sys_path():
    """Insertion order matters: a copy installed in the host
    interpreter's site-packages must not win, or the addon's tamper
    surface depends on what else the user has installed."""
    assert VENDOR in sys.path
    vendor_at = sys.path.index(VENDOR)
    later = [
        i for i, p in enumerate(sys.path)
        if "site-packages" in p or "dist-packages" in p
    ]
    assert all(i > vendor_at for i in later), (
        f"vendor/ is at {vendor_at}, behind {[sys.path[i] for i in later if i < vendor_at]}"
    )


# ---- 2. the addon's call sites reach the SDK's objects ------------------

def test_the_client_the_adapter_builds_is_the_sdks_client():
    assert _sdk.Client is scruple_host_sdk.Client
    assert _sdk.Client is sys.modules["scruple_host_sdk.client"].Client


def test_the_session_client_uses_the_sdks_queue_and_state(sdk_client):
    from scruple_host_sdk.queue import QueueStore
    from scruple_host_sdk.state import SessionState
    assert isinstance(sdk_client.queue, QueueStore)
    assert isinstance(sdk_client.state, SessionState)


def test_the_witness_call_goes_through_the_sdks_single_gateway(attached_client, http_opener, tmp_path, monkeypatch):
    """http.submit() is the only function in the SDK that opens a socket.
    Break it and a witness must fail -- which is what proves the adapter
    is not reaching the network some other way."""
    from adapter import flow as _wf
    from scruple_host_sdk import http as _http
    from tests.mocks import bpy_mock

    calls = []
    real_submit = _http.submit
    monkeypatch.setattr(_http, "submit", lambda *a, **k: calls.append(a[1:3]) or real_submit(*a, **k))

    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    _wf.witness_render(attached_client, scene)

    assert ("POST", "/api/v2/witness") in calls


def test_the_adapter_opens_no_sockets_of_its_own():
    """CANON_SKELETON.md §5: an adapter may not construct HTTP requests.
    The SDK enforces this on itself with an AST scan; this is the same
    scan pointed at the adapter."""
    offenders = []
    for path in _source_files():
        with open(path, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in {"requests", "http.client"} or alias.name.startswith("urllib.request"):
                        offenders.append(f"{os.path.relpath(path, ROOT)}: import {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if mod.startswith("urllib.request") or mod in {"requests", "http.client"}:
                    offenders.append(f"{os.path.relpath(path, ROOT)}: from {mod} import ...")
            elif isinstance(node, ast.Attribute) and node.attr == "urlopen":
                offenders.append(f"{os.path.relpath(path, ROOT)}: .urlopen(")
    assert offenders == [], "the adapter reaches the network directly: " + "; ".join(offenders)


# ---- 3. the old implementation is gone ---------------------------------

def test_the_old_lib_package_is_deleted():
    assert not os.path.isdir(os.path.join(ROOT, "lib")), "lib/ still exists on disk"


def test_both_implementations_cannot_be_importable():
    """THE control for the whole WO. If `lib` imports, there are two
    implementations of the same contract in one process and the addon's
    is the one nobody tests against the server."""
    sys.modules.pop("lib", None)
    with pytest.raises(ImportError):
        importlib.import_module("lib")


@pytest.mark.parametrize("module", [
    "lib.scruple_client", "lib.queue_store", "lib.witness_flow",
    "lib.manifest", "lib.auth", "lib.payment", "lib.paid_action",
    "lib.capture", "lib.state", "lib.preferences",
])
def test_no_module_of_the_old_lib_is_importable(module):
    sys.modules.pop(module, None)
    with pytest.raises(ImportError):
        importlib.import_module(module)


#: The definitions gap.json listed as duplicated between lib/ and the
#: SDK. Any of them reappearing under a new name is the same defect.
_DUPLICATE_SIGNATURES = (
    r"class\s+QueueStore\b",
    r"class\s+ScrupleClient\b",
    r"def\s+canonicalize\s*\(",
    r"def\s+compute_tamper_surface_hash\s*\(",
    r"def\s+sha256_file\s*\(",
    r"def\s+inline_base64\s*\(",
    r"def\s+load_cached\s*\(",
    r"def\s+save_cached\s*\(",
    r"def\s+run_browser_handshake\s*\(",
    r"def\s+price_cents_for\s*\(",
    r"def\s+build_confirm_message\s*\(",
)


def test_no_second_implementation_of_an_sdk_module_exists_in_the_tree():
    """Deleting lib/ is not enough if the same code comes back somewhere
    else. This greps every source file the addon ships for the
    definitions the SDK owns."""
    offenders = []
    for path in _source_files():
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
        for pattern in _DUPLICATE_SIGNATURES:
            if re.search(pattern, source):
                offenders.append(f"{os.path.relpath(path, ROOT)}: {pattern}")
    assert offenders == [], (
        "a second implementation of something the SDK owns is back in the tree: "
        + "; ".join(offenders)
    )


def test_the_control_would_fire_on_a_reintroduced_duplicate(tmp_path):
    """The control for the control. The grep above proves nothing unless
    it can fail, so run the same scan over a file that DOES contain a
    duplicate and assert it is caught."""
    fake = tmp_path / "queue_store.py"
    fake.write_text("class QueueStore:\n    pass\n")
    source = fake.read_text()
    assert any(re.search(p, source) for p in _DUPLICATE_SIGNATURES)


# ---- the vendoring itself ----------------------------------------------

def test_vendor_manifest_records_a_real_source_commit():
    info = _sdk.vendored_sdk_info()
    assert info, "vendor/VENDOR.json is missing"
    assert re.fullmatch(r"[0-9a-f]{40}", info["source_commit"]), info.get("source_commit")
    assert info["source_repo"]
    assert info["files"], "no files recorded"


def test_every_vendored_file_hashes_to_what_the_manifest_says():
    """A vendored copy edited in place is the failure mode vendoring
    invites. build/verify_vendor.py is the check; this runs it."""
    sys.path.insert(0, os.path.join(ROOT, "build"))
    import verify_vendor
    problems = verify_vendor.verify(VENDOR)
    assert problems == [], "\n".join(problems)


def test_the_vendor_check_catches_a_file_edited_in_place(tmp_path):
    """The control. Copy the vendored tree, change one byte, and the
    verifier must notice."""
    import shutil
    sys.path.insert(0, os.path.join(ROOT, "build"))
    import verify_vendor

    copy = tmp_path / "vendor"
    shutil.copytree(VENDOR, copy)
    victim = copy / "scruple_host_sdk" / "http.py"
    victim.write_text(victim.read_text() + "\n# tampered\n")
    problems = verify_vendor.verify(str(copy))
    assert any("edited in place" in p for p in problems), problems


def test_the_vendor_check_catches_an_unlisted_file(tmp_path):
    import shutil
    sys.path.insert(0, os.path.join(ROOT, "build"))
    import verify_vendor

    copy = tmp_path / "vendor"
    shutil.copytree(VENDOR, copy)
    (copy / "scruple_host_sdk" / "smuggled.py").write_text("# not vendored\n")
    problems = verify_vendor.verify(str(copy))
    assert any("not listed in VENDOR.json" in p for p in problems), problems


def test_the_vendored_copy_matches_the_source_tree_it_came_from():
    """Drift check. Skipped when the source repo is not on this machine,
    which is the normal case for an installed addon."""
    info = _sdk.vendored_sdk_info()
    source_root = os.environ.get("SCRUPLE_WEB_ROOT") or info.get("source_repo", "")
    if not source_root or not os.path.isdir(source_root):
        pytest.skip(f"source repo {source_root!r} not present")

    sys.path.insert(0, os.path.join(ROOT, "build"))
    import verify_vendor
    problems = [p for p in verify_vendor.verify(VENDOR) if "source" in p]
    assert problems == [], "\n".join(problems)


def test_the_build_script_stages_the_vendor_directory():
    """A zip without vendor/ installs and then fails on first import.
    The packager has to carry it."""
    with open(os.path.join(ROOT, "build", "build_addon.sh"), "r", encoding="utf-8") as f:
        script = f.read()
    assert "vendor_sdk.sh --if-available" in script
    assert re.search(r"^\s+vendor \\$", script, re.M), "vendor/ is not in the rsync list"
    assert re.search(r"^\s+adapter \\$", script, re.M), "adapter/ is not in the rsync list"
    assert " lib \\" not in script, "the packager still stages the deleted lib/"
