"""HTTP client for scruple-web.

Uses only Python's stdlib. Blender 3.x+ ships `requests` in its bundled
Python, but urllib avoids the vendored-wheel dance and keeps a single
code path across every Blender version.

Every endpoint accepts an Authorization bearer for API-key clients
(the addon path). The client is intentionally dumb about business
logic; higher-level flows compose these calls.

Mirrors /data/scruple-fusion/lib/scruple_client.py to keep the two
plugins evolvable in lock-step.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_TIMEOUT = 60.0

USER_AGENT = "scruple-blender-addon/0.1.0 (+https://scruple.ai)"


class ScrupleClientError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, body: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class ScrupleClient:
    def __init__(
        self,
        base_url: str = "https://scruple.ai",
        api_key: Optional[str] = None,
        session_cookie: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        opener: Optional[Any] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session_cookie = session_cookie
        self.timeout = timeout
        self._opener = opener

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
        opener = self._opener if self._opener is not None else urllib.request
        try:
            with opener.urlopen(req, timeout=self.timeout) as resp:
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
                f"{method} {path} -> HTTP {e.code}",
                status=e.code,
                body=raw,
            ) from None
        except urllib.error.URLError as e:
            raise ScrupleClientError(f"{method} {path} -> {e.reason}") from None

    def list_projects(self) -> List[Dict[str, Any]]:
        _, body = self._request("GET", "/api/projects")
        if isinstance(body, list):
            return body
        if isinstance(body, dict) and "projects" in body:
            return body["projects"]
        return []

    def get_project(self, project_id: int) -> Dict[str, Any]:
        _, body = self._request("GET", f"/api/projects/{project_id}")
        return body or {}

    def create_project(
        self,
        name: str,
        kind: str = "image",
        blender_data_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"name": name, "kind": kind}
        if blender_data_id:
            payload["fusion_data_id"] = blender_data_id
        _, body = self._request("POST", "/api/projects", body=payload)
        return body or {}

    def witness(
        self,
        project_id: int,
        *,
        filename: str,
        inline_base64: str,
        machine_manifest: Dict[str, Any],
        content_type: str = "application/octet-stream",
        prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Bytes-in, leaf-out.

        The Blender addon uses /api/witness/cad because our source-of-truth
        artefact is a file with local hash (render output, saved .blend,
        exported mesh) and there is no Modal round-trip to attest. The
        server hashes the bytes and folds machine_manifest into the leaf
        preimage.
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

    def get_payment_methods(self) -> Dict[str, Any]:
        _, body = self._request("GET", "/api/stripe/config")
        return body or {}

    def create_payment_intent(
        self,
        project_id: int,
        action: str,
    ) -> Dict[str, Any]:
        body = {"projectId": project_id, "action": action}
        _, payload = self._request("POST", "/api/stripe/payment-intent", body=body)
        return payload or {}

    def confirm_payment(
        self,
        project_id: int,
        payment_intent_id: str,
        action: str,
    ) -> Dict[str, Any]:
        body = {
            "projectId": project_id,
            "paymentIntentId": payment_intent_id,
            "action": action,
        }
        _, payload = self._request("POST", "/api/stripe/confirm", body=body)
        return payload or {}

    def lock_checkpoint(
        self,
        project_id: int,
        payment_intent_id: str,
    ) -> Dict[str, Any]:
        body = {"projectId": project_id, "paymentIntentId": payment_intent_id}
        _, payload = self._request("POST", "/api/lock/checkpoint", body=body)
        return payload or {}

    def lock_local(
        self,
        project_id: int,
        payment_intent_id: str,
    ) -> Dict[str, Any]:
        body = {"projectId": project_id, "paymentIntentId": payment_intent_id}
        _, payload = self._request("POST", "/api/lock/local", body=body)
        return payload or {}

    def lock_chain(
        self,
        project_id: int,
        payment_intent_id: str,
        tier: str = "basic",
    ) -> Dict[str, Any]:
        body = {
            "projectId": project_id,
            "paymentIntentId": payment_intent_id,
            "tier": tier,
        }
        _, payload = self._request("POST", "/api/lock/chain", body=body)
        return payload or {}


def from_env() -> ScrupleClient:
    return ScrupleClient(
        base_url=os.environ.get("SCRUPLE_BASE", "https://scruple.ai"),
        api_key=os.environ.get("SCRUPLE_API_KEY"),
        session_cookie=os.environ.get("SCRUPLE_SESSION_COOKIE"),
    )


def from_preferences() -> Optional[ScrupleClient]:
    """Build a client from the live addon preferences. Returns None if the
    user has not signed in yet."""
    try:
        from . import preferences as _prefs
    except ImportError:
        return None
    key = _prefs.get_api_key()
    if not key:
        return None
    return ScrupleClient(base_url=_prefs.get_base_url(), api_key=key)
