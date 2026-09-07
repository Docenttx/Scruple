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
ResponseValue = Union[Dict[str, Any], Callable[..., Dict[str, Any]]]


class Rejected(Exception):
    """Raised by a mock route to answer non-2xx with a body. Defined here
    as well as re-exported from mocks/v2.py so a test can register a
    refusing route without importing the v2 table."""

    def __init__(self, status: int, body: Dict[str, Any]) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


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
        # Routes matched by path PREFIX, for the two v2 routes whose path
        # carries the identifier: /api/v2/receipt/{leaf_id} and
        # /api/v2/verify/{content_hash}. Registered longest-prefix-first
        # so a more specific route always wins.
        self._prefixes: List[Tuple[str, str, Any, int]] = []
        self.recorded: List[Recorded] = []
        # WO-B4. The server being unreachable, as a transport failure and
        # not as a 500: `http.submit()` treats the two the same for
        # queueing but a client sees a URLError, not a status. Set this and
        # every call raises the way a refused connection does. The attempt
        # is still RECORDED -- a test asserting nothing was sent while
        # offline needs the difference between "did not try" and "tried and
        # could not".
        self.offline = False

    def register(
        self,
        method: str,
        path: str,
        response: ResponseValue,
        status: int = 200,
    ) -> None:
        self._routes[(method.upper(), path)] = response
        self._status[(method.upper(), path)] = status

    def register_prefix(
        self,
        method: str,
        prefix: str,
        response: ResponseValue,
        status: int = 200,
    ) -> None:
        """Register a route matched by path prefix. The handler is called
        with `(body, path=<the full path>)` so it can read the identifier
        the route carries."""
        # Replace an identical (method, prefix) rather than shadowing it.
        # `register()` has always overwritten; a prefix route that could
        # only ever be added would make "the server forgets a leaf" an
        # untestable scenario, because the first registration would keep
        # winning.
        m = method.upper()
        self._prefixes = [e for e in self._prefixes if not (e[0] == m and e[1] == prefix)]
        self._prefixes.append((m, prefix, response, status))
        self._prefixes.sort(key=lambda e: len(e[1]), reverse=True)

    def _resolve(self, method: str, path: str):
        key = (method, path)
        if key in self._routes:
            return self._routes[key], self._status.get(key, 200), False
        for m, prefix, route, status in self._prefixes:
            if m == method and path.startswith(prefix):
                return route, status, True
        return None, 404, False

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

        if self.offline:
            raise urllib.error.URLError("Connection refused (mock opener is offline)")

        route, status, wants_path = self._resolve(method, path)
        if route is None:
            error_body = json.dumps({"error": f"unregistered route {method} {path}"}).encode()
            raise urllib.error.HTTPError(
                full_url, 404, "Not Found",
                {"Content-Type": "application/json"},
                io.BytesIO(error_body),
            )
        try:
            if not callable(route):
                payload = route
            elif wants_path:
                payload = route(body or {}, path=path)
            else:
                payload = route(body or {})
        except Rejected as r:
            # A route that refuses, refusing the way the real one does.
            # Raised rather than returned so a mock route cannot describe
            # a 400 body and still answer 200 -- which is exactly how the
            # old witness mock accepted a `kind` no server accepts.
            raise urllib.error.HTTPError(
                full_url, r.status, "Error",
                {"Content-Type": "application/json"},
                io.BytesIO(json.dumps(r.body).encode()),
            ) from None
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
