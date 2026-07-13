"""WitnessClient — talks to the Scruple witnessing API on behalf of the
integration.

Handles auth, baseline drift detection, and (once vendor-specific
fetchers land per WO-07..11) auto-inclusion of platform_attestation
envelopes.

See docs/wo/2026-07-13-baseline-attestation/WO-05-sdk-python-baseline.md
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import requests

from scruple.baseline import BaselineManifest, compute_baseline_hash, load_manifest
from scruple.envelope import AttestationEnvelope


class BaselineDriftError(RuntimeError):
    """Local baseline hash differs from server's current for the tenant."""


class BaselineOutOfSyncError(RuntimeError):
    """Server rejected two consecutive witness calls with 409 baseline_mismatch."""


class WitnessCallError(RuntimeError):
    """Non-recoverable failure from a witness API call."""


AttestationFetcher = Callable[[str], AttestationEnvelope]


@dataclass
class WitnessClient:
    api_base: str
    tenant: str
    api_key: str
    baseline_manifest_path: Optional[str | os.PathLike] = None
    signer_pubkey_spki_sha256_hex: str = ""
    on_baseline_drift: str = "raise"   # 'raise' | 'warn' | 'auto_rebaseline'

    _manifest: Optional[BaselineManifest] = None
    _current_baseline_hash: Optional[str] = None
    _attestation_fetcher: Optional[AttestationFetcher] = None

    def __post_init__(self) -> None:
        if self.baseline_manifest_path is not None:
            self._manifest = load_manifest(self.baseline_manifest_path)

    # ── Attestation fetcher registration ───────────────────────────────

    def register_attestation_fetcher(self, fetcher: AttestationFetcher) -> None:
        """Register a per-vendor attestation fetcher for auto-inclusion.

        Vendor fetcher modules (scruple.attestation.*) each expose a
        fetch(nonce_hex) function; the customer registers the right one
        based on which platform they're on. Auto-registration matching
        baseline.attestation_provider is a future convenience.
        """
        self._attestation_fetcher = fetcher

    # ── HTTP helpers ───────────────────────────────────────────────────

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _tenant_url(self, path: str) -> str:
        base = self.api_base.rstrip("/")
        return f"{base}/api/v1/tenants/{self.tenant}{path}"

    # ── Baseline management ────────────────────────────────────────────

    def compute_local_baseline(self) -> tuple[str, dict[str, Any]]:
        if self._manifest is None:
            raise ValueError("no baseline manifest configured on this client")
        return compute_baseline_hash(
            self._manifest, self.signer_pubkey_spki_sha256_hex
        )

    def get_current_baseline(self) -> Optional[dict[str, Any]]:
        r = requests.get(self._tenant_url("/baseline/current"), headers=self._headers(), timeout=15)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    def submit_baseline(
        self, *, attestation: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """Submit the current baseline as genesis."""
        baseline_hash, blob = self.compute_local_baseline()
        payload = {
            "manifest": blob,
            "manifest_hash_hex": baseline_hash,
            "signer_pubkey_spki_sha256_hex": self.signer_pubkey_spki_sha256_hex,
            "attestation": attestation,
            "submitted_at": _now_iso(),
        }
        r = requests.post(
            self._tenant_url("/baseline"), headers=self._headers(), json=payload, timeout=30
        )
        if r.status_code != 200:
            raise WitnessCallError(f"submit_baseline failed: HTTP {r.status_code} {r.text}")
        result = r.json()
        self._current_baseline_hash = baseline_hash
        return result

    def rebaseline(
        self,
        reason: str,
        *,
        attestation: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Submit a new baseline superseding the tenant's current."""
        current = self.get_current_baseline()
        if not current:
            raise WitnessCallError("cannot rebaseline: no current baseline; use submit_baseline")
        baseline_hash, blob = self.compute_local_baseline()
        payload = {
            "manifest": blob,
            "manifest_hash_hex": baseline_hash,
            "prev_baseline_hash": current["baseline_hash"],
            "signer_pubkey_spki_sha256_hex": self.signer_pubkey_spki_sha256_hex,
            "attestation": attestation,
            "reason": reason,
            "submitted_at": _now_iso(),
        }
        r = requests.post(
            self._tenant_url("/rebaseline"), headers=self._headers(), json=payload, timeout=30
        )
        if r.status_code != 200:
            raise WitnessCallError(f"rebaseline failed: HTTP {r.status_code} {r.text}")
        result = r.json()
        self._current_baseline_hash = baseline_hash
        return result

    def check_baseline_drift(self) -> bool:
        """Compare local baseline to server's current. Returns True if drift."""
        if self._manifest is None:
            return False
        local_hash, _ = self.compute_local_baseline()
        current = self.get_current_baseline()
        server_hash = current["baseline_hash"] if current else None
        drifted = server_hash is not None and local_hash != server_hash
        if drifted:
            if self.on_baseline_drift == "raise":
                raise BaselineDriftError(
                    f"local baseline {local_hash} != server current {server_hash}; "
                    "call rebaseline() to reconcile"
                )
            if self.on_baseline_drift == "auto_rebaseline":
                self.rebaseline(reason=f"auto-detected drift from {server_hash} to {local_hash}")
                return False
            # 'warn' — caller may proceed; server will 409 witness calls
        return drifted

    # ── Witness call helper ────────────────────────────────────────────

    def call_witness(
        self,
        stream_name: str,
        leaf_input: dict[str, Any],
    ) -> dict[str, Any]:
        """Submit a leaf to /api/v1/log/{stream_name}.

        Auto-injects X-Baseline-Hash and platform_attestation if the
        baseline requires them and an attestation fetcher is registered.
        """
        headers_extra: dict[str, str] = {}
        if self._current_baseline_hash is None and self._manifest is not None:
            self.check_baseline_drift()
            local_hash, _ = self.compute_local_baseline()
            self._current_baseline_hash = local_hash
        if self._current_baseline_hash:
            headers_extra["X-Baseline-Hash"] = self._current_baseline_hash

        # Auto-fetch attestation if baseline demands it
        if self._manifest and self._manifest.attestation_provider != "none":
            if not self._attestation_fetcher:
                raise WitnessCallError(
                    f"baseline declares attestation.provider={self._manifest.attestation_provider} "
                    "but no attestation fetcher registered; call register_attestation_fetcher()"
                )
            expected_nonce = _compute_expected_nonce(leaf_input)
            env = self._attestation_fetcher(expected_nonce)
            leaf_input = dict(leaf_input)
            leaf_input["platform_attestation"] = env.to_dict()

        url = f"{self.api_base.rstrip('/')}/api/v1/log/{stream_name}"
        r = requests.post(url, headers=self._headers(headers_extra), json=leaf_input, timeout=30)
        if r.status_code == 409:
            # Try once to refresh baseline + retry
            self._current_baseline_hash = None
            self.check_baseline_drift()
            local_hash, _ = self.compute_local_baseline()
            self._current_baseline_hash = local_hash
            headers_extra["X-Baseline-Hash"] = local_hash
            r2 = requests.post(url, headers=self._headers(headers_extra), json=leaf_input, timeout=30)
            if r2.status_code == 409:
                raise BaselineOutOfSyncError(
                    f"witness call still 409 after baseline refresh: {r2.text}"
                )
            r = r2
        if r.status_code >= 400:
            raise WitnessCallError(f"witness call failed: HTTP {r.status_code} {r.text}")
        return r.json()


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _compute_expected_nonce(leaf_input: dict[str, Any]) -> str:
    """SHA-256 of canonical(leaf_input minus platform_attestation)."""
    import hashlib
    from scruple.canonical import canonicalize
    stripped = {k: v for k, v in leaf_input.items() if k != "platform_attestation"}
    return hashlib.sha256(canonicalize(stripped).encode("utf-8")).hexdigest()
