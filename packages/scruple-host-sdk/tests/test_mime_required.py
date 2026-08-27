"""Property 1: MIME is declared, never guessed."""

from __future__ import annotations

import ast
import pathlib

import pytest

from scruple_host_sdk import capture as _capture  # submodule, not the re-exported function -- see __init__.py's docstring
from scruple_host_sdk.errors import MimeRequiredError

PKG_ROOT = pathlib.Path(__file__).resolve().parent.parent / "scruple_host_sdk"


@pytest.mark.parametrize("mime", [None, "", "   "])
def test_capture_refuses_without_an_explicit_mime(tmp_path, mime):
    f = tmp_path / "render.png"
    f.write_bytes(b"not really a png, doesn't matter for this test")

    with pytest.raises(MimeRequiredError):
        _capture.capture(str(f), mime=mime, kind="artifact")


def test_capture_succeeds_with_an_explicit_mime_and_hashes_correctly(tmp_path):
    import hashlib

    f = tmp_path / "clip.flac"
    data = b"flac-shaped bytes, the exact format GPSA v3 broke on guessing"
    f.write_bytes(data)

    payload = _capture.capture(str(f), mime="audio/flac", kind="artifact")

    assert payload["mime"] == "audio/flac"
    assert payload["content_hash"] == hashlib.sha256(data).hexdigest()
    assert payload["filename"] == "clip.flac"


def test_no_module_in_the_package_imports_mimetypes():
    """mimetypes.guess_type() is exactly the extension-based auto-detect
    GPSA v3 flagged for breaking .flac and .jxl (Meshroom's capture.py).
    It must not exist anywhere in this package."""
    offenders = []
    for path in sorted(PKG_ROOT.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(a.name == "mimetypes" for a in node.names):
                offenders.append(path.name)
            if isinstance(node, ast.ImportFrom) and node.module == "mimetypes":
                offenders.append(path.name)
    assert not offenders, f"mimetypes imported in: {offenders}"


def test_no_function_defaults_to_octet_stream():
    """The other half of the same failure mode: four of the six forks
    send application/octet-stream unconditionally as a default parameter
    value, which silently gates the server's image-only watermarker
    shut. No function in this package may default a mime-shaped
    parameter to it (mentioning the string in a docstring/comment, to
    explain why not to do this, is fine -- only a live default value is
    the bug)."""
    offenders = []
    for path in sorted(PKG_ROOT.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                for default in list(node.args.defaults) + list(node.args.kw_defaults):
                    if isinstance(default, ast.Constant) and default.value == "application/octet-stream":
                        offenders.append(f"{path.name}:{node.name}")
    assert not offenders, f"function defaults to application/octet-stream in: {offenders}"
