"""AMD SEV-SNP attestation fetcher.

Uses /dev/sev-guest to request a fresh attestation report from the CVM,
binding the caller's nonce into report_data. Requires the host to be an
SEV-SNP guest with the sev-guest driver loaded.

Not runnable outside a SEV-SNP guest; raises AttestationUnavailable on
hosts without /dev/sev-guest. Actual smoke against a live SEV-SNP guest
is deferred to WO-06 (which runs on a rented SEV-SNP CVM).
"""

from __future__ import annotations

import base64
import datetime
import os
from pathlib import Path

from scruple.attestation import AttestationUnavailable, AttestationFetchError
from scruple.envelope import AttestationEnvelope

SEV_GUEST_DEVICE = Path("/dev/sev-guest")


def fetch(nonce_hex: str) -> AttestationEnvelope:
    """Fetch a fresh SEV-SNP attestation report.

    `nonce_hex` MUST be 64 hex chars (32-byte SHA-256). Its raw bytes
    become the first 32 bytes of the report's `report_data` field.
    """
    if not SEV_GUEST_DEVICE.exists():
        raise AttestationUnavailable(
            f"{SEV_GUEST_DEVICE} not present; not running in SEV-SNP guest"
        )

    if len(nonce_hex) != 64:
        raise ValueError("nonce_hex MUST be 64 hex chars")
    nonce_bytes = bytes.fromhex(nonce_hex)

    # Preferred path: shell to the `snpguest` tool which handles the
    # SEV_SNP_GUEST_MSG_REPORT_REQ ioctl and cert bundle assembly. If
    # snpguest is unavailable, fall back to raw ioctl via ctypes.
    try:
        report_bytes, cert_chain_pem = _fetch_via_snpguest(nonce_bytes)
    except FileNotFoundError:
        report_bytes, cert_chain_pem = _fetch_via_ioctl(nonce_bytes)

    return AttestationEnvelope(
        attestation_type="amd-sev-snp",
        attestation_report=base64.b64encode(report_bytes).decode("ascii"),
        certificate_chain=cert_chain_pem,
        nonce=nonce_hex,
        attestation_time=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    )


def _fetch_via_snpguest(nonce_bytes: bytes) -> tuple[bytes, list[str]]:
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        nonce_path = Path(td) / "nonce.bin"
        report_path = Path(td) / "report.bin"
        certs_path = Path(td) / "certs.pem"

        # snpguest expects report_data as 64 raw bytes; first 32 = our nonce, rest zero
        padded = nonce_bytes + b"\x00" * (64 - len(nonce_bytes))
        nonce_path.write_bytes(padded)

        # snpguest report --random-nonce=false --data-file <in> <out>
        subprocess.run(
            ["snpguest", "report", str(report_path), str(nonce_path)],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["snpguest", "fetch", "vcek", "pem", "genoa", str(certs_path), str(report_path)],
            check=False,  # non-fatal — cert fetch may fail offline; caller can supply
            capture_output=True,
        )
        report_bytes = report_path.read_bytes()
        chain_pem = certs_path.read_text(encoding="utf-8") if certs_path.exists() else ""
        chain = [
            m.group(0) + "\n"
            for m in _iter_pems(chain_pem)
        ]
        return report_bytes, chain


def _fetch_via_ioctl(nonce_bytes: bytes) -> tuple[bytes, list[str]]:
    # Raw ioctl fallback intentionally not implemented in v1 — snpguest
    # is available on any SEV-SNP-capable Ubuntu image via `snap install
    # snpguest` or `cargo install snpguest`. Document the requirement.
    raise AttestationFetchError(
        "snpguest binary not on PATH; install via `snap install snpguest` "
        "or `cargo install snpguest`. Raw-ioctl fallback is not implemented in v1."
    )


def _iter_pems(pem_text: str):
    import re
    return re.finditer(
        r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
        pem_text,
        re.DOTALL,
    )
