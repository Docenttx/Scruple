"""Scruple Signer runtime introspection.

Reads OCI Instance Metadata Service (IMDSv2) at process startup to
determine the running Signer CVM's identity and creation time. Used
by sign.py to:

  1. Enforce the L2-6.3.2/6.4.2 rotation guardrail: if the running
     instance's age exceeds SCRUPLE_SIGNER_MAX_AGE_DAYS, refuse to
     sign. This is the "secondary actuator" per the GPSA delta 2026-07-18.

  2. Emit an `ai.scruple.signer-runtime.v1` assertion in every produced
     C2PA manifest, cryptographically binding the signing instance's
     identity + age to the signed asset. A downstream verifier can
     compute `now - signer_instance_born_at` and confirm the signer was
     within the max-age window when it signed.

The primary actuator lives in OCI (rotation Function terminates aged
instances). This module is defense-in-depth: if the Function fails to
run for any reason, the Signer self-fences on age breach.

Dev-mode graceful degradation: when IMDS is unreachable (local dev or
non-OCI host), all functions return None. The signer then omits the
runtime assertion and skips the age guard. Production systemd unit
must run on an OCI CVM where IMDS is available.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Optional

IMDS_URL = "http://169.254.169.254/opc/v2/instance/"
IMDS_HEADERS = {"Authorization": "Bearer Oracle"}
IMDS_TIMEOUT_SEC = 2.0

# Cached at first call — instance identity doesn't change over the life
# of a process. If IMDS is unreachable, cache the "None" so we don't
# hammer the endpoint on every sign request.
_cache: Dict[str, Any] = {}
_cache_lock = threading.Lock()
_CACHE_KEY_INFO = "info"


def _fetch_imds() -> Optional[Dict[str, Any]]:
    """One-shot IMDS fetch. Returns instance metadata dict or None."""
    try:
        req = urllib.request.Request(IMDS_URL, headers=IMDS_HEADERS)
        with urllib.request.urlopen(req, timeout=IMDS_TIMEOUT_SEC) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _parse_time(v: Any) -> Optional[datetime]:
    """Parse OCI's timeCreated. Some OCI images return epoch milliseconds
    (int) at the top-level `timeCreated`; others return RFC3339 strings
    (typically under definedTags.Oracle-Tags.CreatedOn). Accept both."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        # epoch milliseconds (OCI top-level timeCreated in current IMDS)
        try:
            return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)
        except Exception:
            return None
    if isinstance(v, str):
        s = v
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None
    return None


def _is_production_signer() -> bool:
    """The runtime assertion and age guard are production-Signer-CVM-only.
    Local dev, CI, and non-CVM OCI hosts (like the app-tier VMs) must not
    emit a runtime assertion (would misidentify the signing host) nor
    trip the age guard (would refuse legitimate dev signing).

    Production signals (any one is sufficient):
      1. SCRUPLE_C2PA_VAULT_KEY_OCID is set — populated on the production
         Signer CVM when signing routes through OCI Vault (see vault_sign.py).
      2. /dev/sev-guest exists — the SEV-SNP guest attestation device is only
         present inside an AMD SEV-SNP Confidential VM. Its presence is proof
         the runtime is a CVM regardless of which signing key path is in use
         (Vault or in-CVM SoftHSM or local dev key preserved for cert-chain
         continuity during resubmission signing).

    Escape hatch: SCRUPLE_C2PA_FORCE_DEV=1 unconditionally forces dev mode
    (turns off runtime assertion + age guard). Use only when signing
    reference material on a CVM but explicitly want to omit the assertion.
    """
    if os.environ.get("SCRUPLE_C2PA_FORCE_DEV") == "1":
        return False
    if os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"):
        return True
    return os.path.exists("/dev/sev-guest")


def signer_runtime_info() -> Optional[Dict[str, Any]]:
    """Return {instance_id, image_id, born_at, age_days, max_age_days,
    rotation_policy_version} for the current Signer CVM, or None if:
      - not running on the production Signer CVM (dev / non-signer host)
      - IMDS is unreachable
      - required fields are missing

    Cached for process lifetime.
    """
    with _cache_lock:
        if _CACHE_KEY_INFO in _cache:
            return _cache[_CACHE_KEY_INFO]
        if not _is_production_signer():
            _cache[_CACHE_KEY_INFO] = None
            return None
        raw = _fetch_imds()
        if raw is None:
            _cache[_CACHE_KEY_INFO] = None
            return None
        instance_id = raw.get("id")
        image_id = raw.get("image")
        time_created = raw.get("timeCreated") or raw.get("time_created")
        born_at = _parse_time(time_created)
        info: Optional[Dict[str, Any]] = None
        if instance_id and born_at:
            info = {
                "instance_id": instance_id,
                "image_id": image_id,
                "born_at": born_at.isoformat(),
                "max_age_days": float(os.environ.get(
                    "SCRUPLE_SIGNER_MAX_AGE_DAYS", "60",
                )),
                "rotation_policy_version": os.environ.get(
                    "SCRUPLE_SIGNER_ROTATION_POLICY_VERSION", "2026-07-18",
                ),
            }
        _cache[_CACHE_KEY_INFO] = info
        return info


def signer_age_days() -> Optional[float]:
    """Days since the running CVM was created. None if IMDS unreachable."""
    info = signer_runtime_info()
    if info is None:
        return None
    born_at = _parse_time(info["born_at"])
    if born_at is None:
        return None
    return (datetime.now(timezone.utc) - born_at).total_seconds() / 86400.0


def age_guard_verdict() -> Dict[str, Any]:
    """Compute the sign/refuse-to-sign verdict based on age vs max_age.

    Returns a dict with:
      - refuse: bool — True if signing should be refused
      - reason: str  — human-readable
      - age_days: float | None
      - max_age_days: float | None
      - imds_available: bool

    On dev/non-OCI hosts (IMDS unreachable): refuse=False. The age guard
    is a production-CVM-only mechanism; dev-mode signing is unaffected.
    """
    info = signer_runtime_info()
    if info is None:
        return {
            "refuse": False,
            "reason": "IMDS unreachable — dev-mode signing permitted",
            "age_days": None,
            "max_age_days": None,
            "imds_available": False,
        }
    age = signer_age_days()
    max_age = info["max_age_days"]
    if age is None:
        return {
            "refuse": False,
            "reason": "IMDS available but age parse failed — permitting sign",
            "age_days": None,
            "max_age_days": max_age,
            "imds_available": True,
        }
    if age > max_age:
        return {
            "refuse": True,
            "reason": (
                f"Signer CVM age {age:.2f}d exceeds max {max_age:.0f}d. "
                f"Instance {info['instance_id']} should have been rotated "
                f"by the OCI Signer rotation Function; check "
                f"'scruple-signer-rotation' Function health and Instance "
                f"Pool state."
            ),
            "age_days": age,
            "max_age_days": max_age,
            "imds_available": True,
        }
    return {
        "refuse": False,
        "reason": f"age {age:.2f}d within max {max_age:.0f}d",
        "age_days": age,
        "max_age_days": max_age,
        "imds_available": True,
    }


def runtime_assertion() -> Optional[Dict[str, Any]]:
    """Return a c2pa manifest assertion dict describing the signer
    runtime. Suitable for adding to `manifest['assertions']` before
    `Builder(manifest)`. Returns None on dev/non-OCI hosts (no runtime
    assertion is emitted; the manifest is otherwise identical).

    Label: ai.scruple.signer-runtime.v1
    Payload:
      - signer_instance_id       — OCID of the CVM that signed
      - signer_image_id          — OCID of the golden image
      - signer_instance_born_at  — RFC3339 of instance creation
      - signer_age_days_at_sign  — days between born_at and this call
      - signer_max_age_days      — policy threshold (CVM rotation)
      - signer_rotation_policy_version — policy revision tag
      - os_security_patch_date   — RFC3339 of last OS package install/upgrade
                                    (dnf/apt log extract, §6.3.2/6.4.2)
      - os_security_patch_age_days — days between os_security_patch_date and this call
      - os_security_patch_max_age_days — policy threshold (90 by spec)
      - os_security_patch_source — which log source fired the extraction
    """
    info = signer_runtime_info()
    if info is None:
        return None
    age = signer_age_days()

    # Pull the OS patch verdict so we bind the extracted patch date into
    # every signed manifest. Verifiers can compute now - os_security_patch_date
    # and cross-check that the Signer was patched within the required
    # 90-day window at signing time. Import lazily so tests without the
    # os_patch_check module (or dev hosts) still work.
    patch_date_iso: Optional[str] = None
    patch_age: Optional[float] = None
    patch_max: Optional[float] = None
    patch_source: Optional[str] = None
    try:
        from os_patch_check import patch_recency_verdict
        pv = patch_recency_verdict()
        patch_date_iso = pv.get("patch_date")
        patch_age = pv.get("patch_age_days")
        patch_max = pv.get("max_age_days")
        patch_source = pv.get("source")
    except Exception:
        pass

    return {
        "label": "ai.scruple.signer-runtime.v1",
        "data": {
            "signer_instance_id": info["instance_id"],
            "signer_image_id": info["image_id"],
            "signer_instance_born_at": info["born_at"],
            "signer_age_days_at_sign": (
                round(age, 3) if age is not None else None
            ),
            "signer_max_age_days": info["max_age_days"],
            "signer_rotation_policy_version": info["rotation_policy_version"],
            "os_security_patch_date": patch_date_iso,
            "os_security_patch_age_days": patch_age,
            "os_security_patch_max_age_days": patch_max,
            "os_security_patch_source": patch_source,
        },
    }
