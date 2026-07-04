"""HTTP client for scruple-web. Stdlib only — Fusion's Python doesn't ship requests.

All endpoints accept either a NextAuth session cookie OR an
`Authorization: Bearer <api_key>` header. The add-in uses the Bearer path
because desktop apps don't reliably maintain browser cookie jars.

The client is intentionally thin: it knows nothing about Fusion. Tests
construct it with a fake base URL pointing at a mock server, or the real
scruple-web dev server on localhost:3001.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_TIMEOUT = 60.0  # seconds; witness can take 30+ on chain construction

# Identify ourselves explicitly so Cloudflare's bot-fight rules don't
# greet a default 'Python-urllib/3.x' UA with a 403. Pinned to the
# add-in version so future versions can be tracked / rate-limited
# differently if needed.
USER_AGENT = "scruple-fusion-addin/0.1.0 (+https://scruple.ai)"


class ScrupleClientError(Exception):
    """Raised on non-2xx HTTP responses or transport failures."""

    def __init__(self, message: str, *, status: Optional[int] = None, body: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class ScrupleClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3001",
        api_key: Optional[str] = None,
        session_cookie: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session_cookie = session_cookie
        self.timeout = timeout

    # ------------------------------------------------------------------ HTTP

    def _headers(self) -> Dict[str, str]:
        h: Dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        if self.session_cookie:
            h["Cookie"] = self.session_cookie
        return h

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        query: Optional[Dict[str, Any]] = None,
    ) -> Tuple[int, Any]:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})

        data: Optional[bytes] = None
        headers = self._headers()
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.getcode()
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                payload: Any
                if "json" in ctype:
                    payload = json.loads(raw.decode("utf-8")) if raw else None
                else:
                    payload = raw.decode("utf-8", errors="replace") if raw else ""
                return status, payload
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
            try:
                payload = json.loads(raw) if raw else None
            except Exception:
                payload = raw
            raise ScrupleClientError(
                f"{method} {path} → HTTP {e.code}",
                status=e.code,
                body=raw,
            ) from None
        except urllib.error.URLError as e:
            raise ScrupleClientError(f"{method} {path} → {e.reason}") from None

    # ------------------------------------------------------------------ projects

    def create_project(
        self,
        name: str,
        kind: str = "cad",
        fusion_data_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/projects → { id, name, status, ... }

        If fusion_data_id is passed, server dedupes by URN — returns the
        pre-existing row from the account scan (which has the thumbnail
        + full Fusion Team Hub linkage) instead of creating a duplicate.
        """
        payload: Dict[str, Any] = {"name": name, "kind": kind}
        if fusion_data_id:
            payload["fusion_data_id"] = fusion_data_id
        _, body = self._request("POST", "/api/projects", body=payload)
        return body or {}

    def get_project(self, project_id: int) -> Dict[str, Any]:
        _, body = self._request("GET", f"/api/projects/{project_id}")
        return body or {}

    def set_active_project(self, project_id: int) -> Dict[str, Any]:
        """POST /api/projects/[id]/set-active → mark project as the user's
        active-tracked project. Idempotent."""
        _, body = self._request("POST", f"/api/projects/{project_id}/set-active", body={})
        return body or {}

    def clear_active_project(self) -> Dict[str, Any]:
        """POST /api/projects/clear-active → drop is_active on ALL user's
        projects. Called when the current Fusion doc has no Scruple
        binding (blank, unsaved, or non-tracked design)."""
        _, body = self._request("POST", "/api/projects/clear-active", body={})
        return body or {}

    def list_projects(self) -> List[Dict[str, Any]]:
        _, body = self._request("GET", "/api/projects")
        if isinstance(body, list):
            return body
        if isinstance(body, dict) and "projects" in body:
            return body["projects"]
        return []

    # ------------------------------------------------------------------ witness

    def witness_cad(
        self,
        project_id: int,
        *,
        filename: str,
        inline_base64: str,
        machine_manifest: Dict[str, Any],
        content_type: str = "application/octet-stream",
        prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/witness/cad — direct-witness for CAD source files.

        Returns { ok, iteration, leafHash, runSequence, machineManifestHash, ... }.
        """
        body: Dict[str, Any] = {
            "projectId": project_id,
            "filename": filename,
            "contentType": content_type,
            "inlineBase64": inline_base64,
            "machineManifest": machine_manifest,
        }
        if prompt:
            body["prompt"] = prompt
        _, payload = self._request("POST", "/api/witness/cad", body=body)
        return payload or {}

    # ------------------------------------------------------------------ lock

    def lock_chain(
        self,
        project_id: int,
        payment_intent_id: str,
        tier: str = "pinned",
    ) -> Dict[str, Any]:
        body = {
            "projectId": project_id,
            "paymentIntentId": payment_intent_id,
            "tier": tier,
        }
        _, payload = self._request("POST", "/api/lock/chain", body=body)
        return payload or {}


def from_env() -> ScrupleClient:
    """Construct a client from SCRUPLE_BASE + SCRUPLE_API_KEY env vars."""
    return ScrupleClient(
        base_url=os.environ.get("SCRUPLE_BASE", "http://127.0.0.1:3001"),
        api_key=os.environ.get("SCRUPLE_API_KEY"),
        session_cookie=os.environ.get("SCRUPLE_SESSION_COOKIE"),
    )
