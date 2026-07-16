"""In-memory HTTP mock for the ScrupleClient.

The client accepts an `opener` argument that satisfies the
`urlopen(request, timeout=...)` protocol. This mock plays that role
without any real sockets, so tests are fast and hermetic.

Response registration follows a simple (method, path) key. Each entry
can be a static dict (returned as JSON) or a callable taking the parsed
request body and returning the dict.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

ResponseKey = Tuple[str, str]
ResponseValue = Union[Dict[str, Any], Callable[[Dict[str, Any]], Dict[str, Any]]]


class _FakeResp:
    def __init__(self, status: int, headers: Dict[str, str], body: bytes) -> None:
        self._status = status
        self._headers = headers
        self._body = body
        self.headers = self  # emulate .headers.get

    def get(self, key: str, default: str = "") -> str:
        for k, v in self._headers.items():
            if k.lower() == key.lower():
                return v
        return default

    def getcode(self) -> int:
        return self._status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@dataclass
class Recorded:
    method: str
    path: str
    query: Dict[str, Any]
    headers: Dict[str, str]
    body: Optional[Dict[str, Any]]


class MockOpener:
    def __init__(self, base_url: str = "https://scruple.ai") -> None:
        self.base_url = base_url.rstrip("/")
        self._routes: Dict[ResponseKey, Any] = {}
        self._status: Dict[ResponseKey, int] = {}
        self.recorded: List[Recorded] = []

    def register(
        self,
        method: str,
        path: str,
        response: ResponseValue,
        status: int = 200,
    ) -> None:
        self._routes[(method.upper(), path)] = response
        self._status[(method.upper(), path)] = status

    def urlopen(self, request, timeout=None):
        method = request.get_method()
        full_url = request.full_url
        parsed = urllib.parse.urlparse(full_url)
        path = parsed.path
        query = dict(urllib.parse.parse_qsl(parsed.query))
        headers = dict(request.headers)
        raw_body = request.data
        body: Optional[Dict[str, Any]] = None
        if raw_body:
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = None
        self.recorded.append(Recorded(method, path, query, headers, body))

        key = (method, path)
        route = self._routes.get(key)
        if route is None:
            error_body = json.dumps({"error": f"unregistered route {method} {path}"}).encode()
            raise urllib.error.HTTPError(
                full_url, 404, "Not Found",
                {"Content-Type": "application/json"},
                io.BytesIO(error_body),
            )
        status = self._status.get(key, 200)
        payload = route(body or {}) if callable(route) else route
        raw = json.dumps(payload).encode("utf-8") if not isinstance(payload, (bytes, bytearray)) else bytes(payload)
        if status >= 400:
            raise urllib.error.HTTPError(
                full_url, status, "Error",
                {"Content-Type": "application/json"},
                io.BytesIO(raw),
            )
        return _FakeResp(status, {"Content-Type": "application/json"}, raw)


def new(base_url: str = "https://scruple.ai") -> MockOpener:
    return MockOpener(base_url=base_url)
