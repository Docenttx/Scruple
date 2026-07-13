"""Baseline manifest + hash computation.

Reads scruple-baseline.yaml, resolves file globs, hashes each declared
tamper-surface element, and produces a deterministic 32-byte baseline
hash. The same baseline manifest + same file content = same hash on
every run and every language port.

See docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md §2 P2 and
docs/wo/2026-07-13-baseline-attestation/WO-05-sdk-python-baseline.md.
"""

from __future__ import annotations

import glob
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

from scruple.canonical import canonicalize


@dataclass
class ConfigEnv:
    name: str
    value: Optional[str] = None
    handle: Optional[str] = None  # for secret env, hold handle not value


@dataclass
class BaselineManifest:
    integration_id: str
    version: str
    declared_at: str
    code: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    deployment_service_units: list[str] = field(default_factory=list)
    config_env: list[ConfigEnv] = field(default_factory=list)
    attestation_provider: str = "none"
    verifier_reference: Optional[str] = None
    _manifest_path: Optional[Path] = None
    _raw_yaml: str = ""


def load_manifest(path: str | os.PathLike) -> BaselineManifest:
    """Read and parse a scruple-baseline.yaml file.

    Raises FileNotFoundError if the manifest doesn't exist, or a
    ValueError with a specific message if the YAML shape is bad.
    """
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise ValueError("scruple-baseline.yaml top-level MUST be a mapping")

    def req_str(k: str) -> str:
        v = data.get(k)
        if not isinstance(v, str) or not v:
            raise ValueError(f"scruple-baseline.yaml: '{k}' MUST be a non-empty string")
        return v

    integration_id = req_str("integration_id")
    version = req_str("version")
    declared_at = req_str("declared_at")

    code = _path_list(data.get("code"), "code")
    deps = _path_list(data.get("dependencies"), "dependencies")

    deployment = data.get("deployment", {}) or {}
    service_units = deployment.get("service_units") or []
    if not isinstance(service_units, list):
        raise ValueError("deployment.service_units MUST be a list")
    service_units = [_extract_path(x, "deployment.service_units") for x in service_units]

    config = data.get("config", {}) or {}
    env_entries: list[ConfigEnv] = []
    for i, entry in enumerate(config.get("env", []) or []):
        if not isinstance(entry, dict) or "name" not in entry:
            raise ValueError(f"config.env[{i}] MUST have 'name'")
        env_entries.append(
            ConfigEnv(
                name=entry["name"],
                value=entry.get("value"),
                handle=entry.get("handle"),
            )
        )

    attestation = data.get("attestation", {}) or {}
    provider = attestation.get("provider", "none")
    if not isinstance(provider, str):
        raise ValueError("attestation.provider MUST be a string")
    verifier_reference = attestation.get("verifier_reference")

    return BaselineManifest(
        integration_id=integration_id,
        version=version,
        declared_at=declared_at,
        code=code,
        dependencies=deps,
        deployment_service_units=service_units,
        config_env=env_entries,
        attestation_provider=provider,
        verifier_reference=verifier_reference,
        _manifest_path=p,
        _raw_yaml=raw,
    )


def _path_list(v: Any, field_name: str) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise ValueError(f"{field_name} MUST be a list")
    return [_extract_path(x, field_name) for x in v]


def _extract_path(x: Any, ctx: str) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, dict) and isinstance(x.get("path"), str):
        return x["path"]
    raise ValueError(f"{ctx} entries MUST be strings or objects with 'path'")


def _hash_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _expand_and_hash(patterns: list[str], base_dir: Path) -> list[dict[str, str]]:
    """Expand glob patterns relative to base_dir; hash each resolved file."""
    seen: set[str] = set()
    results: list[dict[str, str]] = []
    for pat in patterns:
        matches = sorted(glob.glob(str(base_dir / pat), recursive=True))
        for m in matches:
            mp = Path(m)
            if not mp.is_file():
                continue
            rel = str(mp.relative_to(base_dir))
            if rel in seen:
                continue
            seen.add(rel)
            results.append({"path": rel, "sha256_hex": _hash_file(mp)})
    results.sort(key=lambda x: x["path"])
    return results


def compute_baseline_hash(
    manifest: BaselineManifest,
    signer_pubkey_spki_sha256_hex: str,
    base_dir: Optional[Path] = None,
) -> tuple[str, dict[str, Any]]:
    """Compute the baseline hash + return the canonical blob.

    Returns (hex_baseline_hash, canonical_blob_dict). The canonical
    blob is what the server persists as the baseline's `manifest_json`.

    `signer_pubkey_spki_sha256_hex` is the SHA-256 of the integration's
    baseline signing key SPKI (DER-encoded). The integration generates
    this keypair at install time; the private key stays in the tenant's
    secret manager (per P3).

    `base_dir` defaults to the directory containing the manifest.
    """
    if base_dir is None:
        if manifest._manifest_path is None:
            raise ValueError("base_dir required when manifest was constructed inline")
        base_dir = manifest._manifest_path.parent

    manifest_hash = hashlib.sha256(manifest._raw_yaml.encode("utf-8")).hexdigest()

    code_files = _expand_and_hash(manifest.code, base_dir)
    dep_files = _expand_and_hash(manifest.dependencies, base_dir)
    service_units = _expand_and_hash(manifest.deployment_service_units, Path("/"))

    config_env = sorted(
        (
            {
                "name": e.name,
                # For value-type env, resolve the CURRENT env value at hash time
                # (so baseline includes what the integration will actually see).
                # For handle-type env, use the handle string verbatim (never
                # dereferences the secret).
                "value_or_handle": (
                    e.handle
                    if e.handle is not None
                    else (os.environ.get(e.name, "") if e.value is None else e.value)
                ),
            }
            for e in manifest.config_env
        ),
        key=lambda x: x["name"],
    )

    blob: dict[str, Any] = {
        "integration_id": manifest.integration_id,
        "version": manifest.version,
        "manifest_hash_hex": manifest_hash,
        "code_files": code_files,
        "dep_files": dep_files,
        "service_units": service_units,
        "config_env": config_env,
        "attestation_provider": manifest.attestation_provider,
        "signer_pubkey_spki_sha256_hex": signer_pubkey_spki_sha256_hex,
    }
    if manifest.verifier_reference:
        blob["verifier_reference"] = manifest.verifier_reference

    canon = canonicalize(blob).encode("utf-8")
    baseline_hash = hashlib.sha256(canon).hexdigest()
    return baseline_hash, blob
