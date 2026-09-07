"""The ONLY module in this package that opens a network connection to
scruple.ai.

`submit()` is the single gateway every other module uses to reach the
server -- capabilities.py, witness_flow.py, payment.py, client.py all
call it and nothing else. No other module in this package imports
`urllib.request`, calls `urlopen`, or imports `requests`/`http.client`.
That is not a convention documented here and left to discipline; it is
checked mechanically by
`tests/test_queue_construction.py::test_only_http_module_touches_the_network`,
which parses every module in this package except this one and fails the
suite if it finds a raw network call. Move a network call out of this
file and that test fails, by design.

WHY THIS IS THE QUEUE-BY-CONSTRUCTION GUARANTEE (CANON_SKELETON.md §5,
property 3; D-10; Standard §7):

Six forks each wrote a queue_store.py, wrote tests for it, and never
called it from the code path that fails. The fix here is not "write the
queue better" -- Blender's queue_store.py, ported almost unchanged into
queue.py, was already fine. The fix is that there is exactly one
function in this entire package capable of making the network call that
can fail, and enqueuing on failure is inline in that function's own
control flow, not a step a caller can skip. Read `submit()` below: for
any call with `queue_kind` set, every return path that reports failure
is preceded by `session.queue.enqueue(...)`. There is no way to add a
new failure path to this function without either enqueuing or refusing
to compile against the reviewer's attention to this one function.

WHAT GETS QUEUED AND WHAT DOES NOT. Only calls made with `queue_kind`
set are enqueued on failure -- these are the Phase-3 operations Standard
§7 is actually about: witness, mark, baseline, rebaseline. A GET against
/capabilities, /receipt or /verify is a query, not an operation; there
is nothing to replay if it fails, so `queue_kind=None` (the default)
means "if this fails, tell the caller, do not queue it." Payment-intent
creation also passes queue_kind=None deliberately: silently retrying a
finance-adjacent request is a different kind of unsafe than retrying a
witness POST, and that is a judgment call, not an oversight -- see
payment.py.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .errors import ScrupleTransportError

DEFAULT_TIMEOUT = 30.0
USER_AGENT = "scruple-host-sdk/0.1.0 (+https://scruple.ai)"


@dataclass(frozen=True)
class Result:
    ok: bool
    status: Optional[int]
    body: Any
    error: Optional[str] = None
    queued: bool = False
    queue_id: Optional[str] = None


def _transport(
    base_url: str,
    api_key: Optional[str],
    method: str,
    path: str,
    *,
    body: Optional[Dict[str, Any]] = None,
    query: Optional[Dict[str, Any]] = None,
    timeout: float = DEFAULT_TIMEOUT,
    opener: Optional[Any] = None,
) -> "tuple[int, Any]":
    """Private. The one place in this package that constructs and sends
    an HTTP request. Never call this directly from outside this module --
    it has no failure-handling of its own; that is submit()'s job."""
    url = base_url.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})

    data: Optional[bytes] = None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    active_opener = opener if opener is not None else urllib.request

    try:
        with active_opener.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read() if e.fp else b""
    except urllib.error.URLError as e:
        raise ScrupleTransportError(str(e.reason)) from None
    except OSError as e:
        raise ScrupleTransportError(str(e)) from None

    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return status, raw.decode("utf-8", errors="replace")


def submit(
    session: Any,
    method: str,
    path: str,
    *,
    body: Optional[Dict[str, Any]] = None,
    query: Optional[Dict[str, Any]] = None,
    queue_kind: Optional[str] = None,
    queue_replay: Optional[Dict[str, Any]] = None,
) -> Result:
    """THE gateway. `session` needs `.base_url`, `.api_key`, `.timeout`,
    `.opener` and, when `queue_kind` is set, `.queue` (a queue.QueueStore).
    `Client` in client.py provides all five directly, so `session` in
    practice is always a `Client`.

    On a transport-level failure (DNS, refused connection, timeout) or a
    5xx response, and only when `queue_kind` is not None, the request is
    enqueued via `session.queue.enqueue()` BEFORE this function returns.
    `queue_replay` is the logical request body to persist for replay --
    pass it when `body` contains anything that should not be re-sent
    verbatim (there is no such case yet, but the seam exists so adding
    one does not require touching the enqueue call site). When omitted,
    `body` itself is what gets queued.
    """
    try:
        status, payload = _transport(
            session.base_url,
            session.api_key,
            method,
            path,
            body=body,
            query=query,
            timeout=session.timeout,
            opener=session.opener,
        )
    except ScrupleTransportError as e:
        if queue_kind is not None:
            entry = session.queue.enqueue(
                kind=queue_kind,
                method=method,
                path=path,
                body=queue_replay if queue_replay is not None else body,
            )
            return Result(ok=False, status=None, body=None, error=str(e), queued=True, queue_id=entry["id"])
        return Result(ok=False, status=None, body=None, error=str(e), queued=False)

    if status >= 500 and queue_kind is not None:
        entry = session.queue.enqueue(
            kind=queue_kind,
            method=method,
            path=path,
            body=queue_replay if queue_replay is not None else body,
        )
        return Result(ok=False, status=status, body=payload, error=f"HTTP {status}", queued=True, queue_id=entry["id"])

    ok = 200 <= status < 300
    return Result(ok=ok, status=status, body=payload, error=None if ok else f"HTTP {status}")
