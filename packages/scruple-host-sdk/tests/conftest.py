"""Shared test fixtures. No real HTTP is ever performed -- FakeOpener
stands in for `session.opener` (see http.py's `_transport`, which uses
`opener.urlopen(req, timeout=...)` exactly the way `urllib.request`
would)."""

from __future__ import annotations

import json
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

import pytest

from scruple_host_sdk.client import Client


class _FakeResponse:
    def __init__(self, status: int, body: Any) -> None:
        self._status = status
        self._body = b"" if body is None else json.dumps(body).encode("utf-8")

    def getcode(self) -> int:
        return self._status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False


class FakeOpener:
    """A programmable stand-in for the `urllib.request` module.

    `script` is a list consumed in call order. Each entry is one of:
      ("ok", status, body)                    -> a normal response
      ("http_error", status, body)             -> raises urllib.error.HTTPError
      ("network_error",)                       -> raises urllib.error.URLError
    """

    def __init__(self, script: List[Tuple[Any, ...]]) -> None:
        self.script = list(script)
        self.calls: List[Dict[str, Any]] = []

    def urlopen(self, req: Any, timeout: Optional[float] = None) -> _FakeResponse:
        self.calls.append(
            {
                "url": req.full_url,
                "method": req.get_method(),
                "body": json.loads(req.data) if req.data else None,
            }
        )
        if not self.script:
            raise AssertionError(f"FakeOpener script exhausted at call #{len(self.calls)}: {req.full_url}")
        entry = self.script.pop(0)
        kind = entry[0]
        if kind == "ok":
            _, status, body = entry
            return _FakeResponse(status, body)
        if kind == "http_error":
            _, status, body = entry
            raw = json.dumps(body).encode("utf-8") if body is not None else b""
            raise urllib.error.HTTPError(req.full_url, status, "error", {}, __import__("io").BytesIO(raw))
        if kind == "network_error":
            raise urllib.error.URLError("connection refused")
        raise AssertionError(f"unknown FakeOpener script entry: {entry!r}")


@pytest.fixture
def make_client(tmp_path):
    def _make(script: Optional[List[Tuple[Any, ...]]] = None, **kwargs: Any):
        opener = FakeOpener(script or [])
        client = Client(
            host=kwargs.pop("host", "testhost"),
            integration_version=kwargs.pop("integration_version", "1.0.0"),
            api_key=kwargs.pop("api_key", "sk_test_123"),
            base_url=kwargs.pop("base_url", "https://scruple.test"),
            opener=opener,
            cache_dir=str(tmp_path / ".scruple"),
            queue_path=str(tmp_path / "queue.jsonl"),
            **kwargs,
        )
        return client, opener

    return _make
