"""The Client. This is the only object an adapter should import from
this package.

CANON_SKELETON.md §5: "What an adapter may not do: construct HTTP
requests, handle payment, decide MIME, decide applicability, or write
its own retry. If an adapter needs one of these, the SDK is missing
something and the SDK is where it gets added." Every one of those is a
method here (or a deliberate omission -- there is no
`client.request(...)` escape hatch). `capture()` requires the caller to
declare MIME; `mark()` checks applicability before sending anything;
`detach()` is the only way to retry a queued request; nothing on this
class opens a socket directly -- see http.py.

`Client` instances double as the `session` object every functional
module (http.submit, capabilities.fetch, witness_flow.witness/mark,
payment.charge) expects: `.base_url`, `.api_key`, `.timeout`, `.opener`,
`.queue`, `.state`. That is why those functions take a bare `session`
parameter instead of importing Client -- it avoids a circular import and
keeps each module testable with a lightweight stand-in.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Iterable, List, Optional

from scruple_api.outcomes import AttachResult

from . import auth as _auth
from . import capabilities as _capabilities
from . import capture as _capture
from . import http as _http
from . import manifest as _manifest
from . import payment as _payment
from . import preferences as _preferences
from . import queue as _queue
from . import state as _state
from . import witness_flow as _witness_flow
from .errors import ScrupleAPIError


class Client:
    def __init__(
        self,
        *,
        host: str,
        integration_version: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        queue_path: Optional[str] = None,
        opener: Optional[Any] = None,
        cache_dir: Optional[str] = None,
    ) -> None:
        self.host = host
        self.integration_version = integration_version
        self._cache_dir = cache_dir or _auth.CACHE_DIR

        self.prefs = _preferences.Preferences(
            base_url=base_url or _preferences.DEFAULT_BASE_URL,
            timeout=timeout if timeout is not None else _preferences.DEFAULT_TIMEOUT_SECONDS,
        )
        self.base_url = self.prefs.normalized_base_url()
        self.timeout = self.prefs.timeout
        self.opener = opener

        self.api_key = api_key or (_auth.load_cached(host, cache_dir=self._cache_dir).get("api_key"))

        import os as _os

        qp = queue_path or _os.path.join(self._cache_dir, f"{_auth._safe_host(host)}-queue.jsonl")
        self.queue = _queue.QueueStore(qp)
        self.state = _state.SessionState(host=host, integration_version=integration_version)

    # ---- auth -----------------------------------------------------
    def sign_in(self, *, open_browser=None, timeout_seconds: Optional[float] = None) -> Optional[str]:
        kwargs: Dict[str, Any] = {"cache_dir": self._cache_dir}
        if open_browser is not None:
            kwargs["open_browser"] = open_browser
        if timeout_seconds is not None:
            kwargs["timeout_seconds"] = timeout_seconds
        key = _auth.run_browser_handshake(self.base_url, self.host, **kwargs)
        if key:
            self.api_key = key
        return key

    def sign_in_with_key(self, api_key: str) -> bool:
        ok = _auth.apply_manual_key(self.host, api_key, base_url=self.base_url, cache_dir=self._cache_dir)
        if ok:
            self.api_key = api_key.strip()
        return ok

    def sign_out(self) -> None:
        _auth.clear_cached(self.host, cache_dir=self._cache_dir)
        self.api_key = None

    @property
    def is_authed(self) -> bool:
        return bool(self.api_key)

    # ---- lifecycle: attach / detach / rebaseline (host hook contract §4) --
    def attach(
        self,
        *,
        host_version: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        code_paths: Optional[Iterable[str]] = None,
        attestation: Optional[Dict[str, Any]] = None,
        anchor_publicly: bool = False,
    ) -> AttachResult:
        """Establish-or-verify the baseline (D-3). Must succeed before
        witness() or mark() will do anything -- both refuse client-side
        with NoBaselineError otherwise; they do not rely on the server's
        409 to enforce this."""
        tsh = _manifest.compute_tamper_surface_hash(
            integration_version=self.integration_version, config=config, code_paths=code_paths
        )

        current = _http.submit(self, "GET", "/api/v2/baseline/current")
        if current.ok and isinstance(current.body, dict):
            server_ref = current.body.get("baseline_ref")
            self.state.baseline_ref = server_ref
            self.state.tamper_surface_hash = tsh
            return AttachResult(
                baseline_ref=server_ref,
                established=False,
                drifted=(server_ref != tsh),
                server_baseline_ref=server_ref,
            )

        body: Dict[str, Any] = {
            "host": self.host,
            "integration_version": self.integration_version,
            "tamper_surface_hash": tsh,
            "anchor_publicly": anchor_publicly,
        }
        if host_version is not None:
            body["host_version"] = host_version
        if attestation is not None:
            body["attestation"] = attestation

        created = _http.submit(self, "POST", "/api/v2/baseline", body=body)
        if created.ok and isinstance(created.body, dict):
            self.state.baseline_ref = created.body.get("baseline_ref")
            self.state.tamper_surface_hash = tsh
            return AttachResult(baseline_ref=self.state.baseline_ref, established=True, drifted=False)

        # Deliberately NOT queued. A baseline is a precondition every
        # later call is gated on, not itself a Phase-3 event (§7) -- see
        # http.submit()'s docstring. Leaving state.baseline_ref unset is
        # what makes witness()/mark() refuse afterward.
        raise ScrupleAPIError(
            f"attach() could not establish or verify a baseline: {created.error or current.error}",
            status=created.status,
        )

    def rebaseline(
        self,
        *,
        reason: str,
        detail: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        code_paths: Optional[Iterable[str]] = None,
    ) -> AttachResult:
        tsh = _manifest.compute_tamper_surface_hash(
            integration_version=self.integration_version, config=config, code_paths=code_paths
        )
        body: Dict[str, Any] = {"tamper_surface_hash": tsh, "reason": reason}
        if detail:
            body["detail"] = detail

        result = _http.submit(self, "POST", "/api/v2/baseline/rebaseline", body=body)
        if not result.ok or not isinstance(result.body, dict):
            raise ScrupleAPIError(f"rebaseline() failed: {result.error}", status=result.status)

        self.state.baseline_ref = result.body.get("baseline_ref")
        self.state.tamper_surface_hash = tsh
        return AttachResult(baseline_ref=self.state.baseline_ref, established=True, drifted=False)

    def detach(self) -> Dict[str, int]:
        """Flush the retry queue -- call on addon-disable / host-quit
        (and from `idle.tick`, if the host has one). Uses queue_kind=None
        on the retry submit: an entry already IN the queue must not be
        re-enqueued a second time on repeated failure, see
        queue.QueueStore.drain()'s docstring."""

        def _retry(entry: Dict[str, Any]) -> _http.Result:
            return _http.submit(self, entry["method"], entry["path"], body=entry.get("body"), queue_kind=None)

        return self.queue.drain(_retry)

    @property
    def queue_depth(self) -> int:
        return self.queue.count()

    # ---- capabilities (D-7) -----------------------------------------
    def capabilities(self, *, mime: str) -> List[_capabilities.Capability]:
        return _capabilities.fetch(self, host=self.host, mime=mime)

    # ---- capture / witness / mark -------------------------------------
    def capture(self, path: str, *, mime: str, kind: str, workflow: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return _capture.capture(path, mime=mime, kind=kind, workflow=workflow)

    def witness(self, *, kind: str, content_hash: str, mime: str, **kwargs: Any) -> _witness_flow.WitnessOutcome:
        return _witness_flow.witness(self, kind=kind, content_hash=content_hash, mime=mime, **kwargs)

    def witness_file(
        self,
        path: str,
        *,
        mime: str,
        kind: str,
        workflow: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> _witness_flow.WitnessOutcome:
        """capture() + witness() in one call -- the common case: the
        adapter just wrote a file and wants it on the record."""
        payload = self.capture(path, mime=mime, kind=kind, workflow=workflow)
        outcome = self.witness(kind=kind, content_hash=payload["content_hash"], mime=mime, **kwargs)
        self.state.record_receipt(
            {
                "filename": payload["filename"],
                "content_hash": payload["content_hash"],
                "leaf_id": outcome.leaf_id,
                "witnessed": outcome.witnessed,
                "queued": outcome.queued,
            }
        )
        return outcome

    def mark(
        self,
        *,
        leaf_id: str,
        mime: str,
        modalities: Optional[List[str]] = None,
        chain_tier: Optional[str] = None,
        payment_intent_id: Optional[str] = None,
    ) -> _witness_flow.MarkOutcome:
        return _witness_flow.mark(
            self,
            leaf_id=leaf_id,
            host=self.host,
            mime=mime,
            modalities=modalities,
            chain_tier=chain_tier,
            payment_intent_id=payment_intent_id,
        )

    # ---- payment (see payment.py's docstring for the real-route gap) --
    def charge(self, *, project_id: int, action: str, confirm: Callable[[str], bool]) -> _payment.PaymentResult:
        return _payment.charge(self, project_id=project_id, action=action, confirm=confirm)

    # ---- public reads ---------------------------------------------------
    def receipt(self, leaf_id: str) -> Dict[str, Any]:
        result = _http.submit(self, "GET", f"/api/v2/receipt/{leaf_id}")
        if not result.ok:
            raise ScrupleAPIError(f"receipt({leaf_id}) failed: {result.error}", status=result.status)
        return result.body or {}

    def verify(self, content_hash: str) -> Dict[str, Any]:
        result = _http.submit(self, "GET", f"/api/v2/verify/{content_hash}")
        if not result.ok:
            raise ScrupleAPIError(f"verify() failed: {result.error}", status=result.status)
        return result.body or {}
