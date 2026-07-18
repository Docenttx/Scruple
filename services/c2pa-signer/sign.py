#!/usr/bin/env python3
"""Scruple C2PA signer — subprocess entry point.

Reads a JSON job spec from stdin, signs the asset, writes the signed
asset to disk, prints a JSON result to stdout.

Job spec:
    {
        "asset_path": "/tmp/thumb.png",
        "output_path": "/tmp/thumb.c2pa.png",
        "cert_path":   ".../keys/es256.pub",   # public cert chain PEM
        "key_path":    ".../keys/es256.pem",   # LOCAL MODE ONLY — ignored
                                               # in Vault mode. Kept for
                                               # backward-compat.
        "manifest": {
            "claim_generator": "Scruple/0.1 (c2pa-python 0.89)",
            "format": "image/png",
            "title": "MyDesign",
            "assertions": [...]           # non-c2pa assertions only
        },
        "intent": "CREATE",               # C2paBuilderIntent name;
                                          # defaults to CREATE
        "digital_source_type":            # C2paDigitalSourceType name;
            "TRAINED_ALGORITHMIC_MEDIA",  # defaults to
                                          # TRAINED_ALGORITHMIC_MEDIA
        "actions": [                      # supplementary actions, added
            {"action": "c2pa.published",  # AFTER SDK's inception c2pa.created
             "softwareAgent": "Scruple/0.1"}
        ]
    }

Result (success):
    { "ok": true, "output_path": "...", "bytes": 12345,
      "signing_mode": "vault" | "local",
      "signer_identity": "vault:...<last-8-of-ocid>" | "local:<path>" }

Result (failure):
    { "ok": false, "error": "...", "trace": [...] }

Signing path:
  c2pa-python 0.89 Signer.from_callback(vault_sign_es256, ES256, cert_pem, ta_url)

The callback dispatches to OCI Vault (Sign API) when
SCRUPLE_C2PA_VAULT_KEY_OCID is set; otherwise loads the local PEM.
Same output shape either way — c2pa-python doesn't need to know.

Actions are constructed via Builder.set_intent() (inception action +
digitalSourceType) and Builder.add_action() (supplementary actions) —
the c2pa-python 0.89 first-class API. Raw c2pa.actions.v2 assertion
injection is not supported here; that path did not satisfy the C2PA v2
assertion-bucket placement, digitalSourceType requirement, or inception-
first ordering per reviewer feedback 2026-07-16.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path


def main() -> int:
    try:
        raw = sys.stdin.read()
        job = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad job JSON: {e}"}))
        return 1

    try:
        asset_path = Path(job["asset_path"]).resolve()
        output_path = Path(job["output_path"]).resolve()
        cert_path = Path(job["cert_path"]).resolve()
        manifest = job["manifest"]
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"missing field {e}"}))
        return 1

    # key_path is honored only in LOCAL mode (i.e., when the Vault OCID
    # env var is unset). In Vault mode, key material is inside OCI Vault
    # and this field is silently ignored.
    if not os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"):
        key_path = job.get("key_path")
        if key_path:
            os.environ["SCRUPLE_C2PA_LOCAL_KEY_PATH"] = str(Path(key_path).resolve())

    if not asset_path.exists():
        print(json.dumps({"ok": False, "error": f"asset not found: {asset_path}"}))
        return 1
    if not cert_path.exists():
        print(json.dumps({"ok": False, "error": f"cert not found: {cert_path}"}))
        return 1

    try:
        import c2pa
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"c2pa import failed: {e}"}))
        return 1

    # Import our callback shim. Its module-level import chain is light
    # (cryptography only); OCI SDK is lazy-imported inside the callback.
    try:
        # Ensure this file's directory is on sys.path so `vault_sign`
        # resolves without a full package install.
        HERE = Path(__file__).resolve().parent
        if str(HERE) not in sys.path:
            sys.path.insert(0, str(HERE))
        from vault_sign import vault_sign_es256, signing_mode, signer_identity
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"vault_sign import failed: {e}"}))
        return 1

    # Dev-mode trust relaxation — only when SCRUPLE_C2PA_DEV=1 exactly.
    # The prod systemd unit sets SCRUPLE_C2PA_DEV="" (empty), which fails
    # the equality check.
    if os.environ.get("SCRUPLE_C2PA_DEV") == "1":
        try:
            c2pa.load_settings(
                '{"verify":{"verify_after_sign":false,"verify_trust":false}}',
                "json",
            )
        except Exception:
            pass  # older SDKs don't need it

    try:
        cert_bytes = cert_path.read_bytes()
        cert_str = cert_bytes.decode("utf-8")
        ta_url = os.environ.get("SCRUPLE_C2PA_TA_URL") or None

        # Signer.from_callback: raw ES256 R||S (64 bytes) per RFC 8152.
        # Kwarg is `tsa_url` (matches c2pa-python 0.89).
        signer = c2pa.Signer.from_callback(
            callback=vault_sign_es256,
            alg=c2pa.C2paSigningAlg.ES256,
            certs=cert_str,
            tsa_url=ta_url,
        )

        builder = c2pa.Builder(manifest)

        # Intent + digitalSourceType — SDK emits the inception action
        # (c2pa.created or c2pa.opened depending on intent) first, with
        # the required digitalSourceType field.
        intent_name = job.get("intent", "CREATE")
        dst_name = job.get("digital_source_type", "TRAINED_ALGORITHMIC_MEDIA")
        try:
            intent = getattr(c2pa.C2paBuilderIntent, intent_name)
        except AttributeError:
            print(json.dumps({"ok": False, "error": f"unknown intent: {intent_name}"}))
            return 1
        try:
            dst = getattr(c2pa.C2paDigitalSourceType, dst_name)
        except AttributeError:
            print(json.dumps({"ok": False, "error": f"unknown digital_source_type: {dst_name}"}))
            return 1
        builder.set_intent(intent, dst)

        # Supplementary actions — placed after the SDK-emitted inception
        # action, so inception-first ordering is preserved.
        for act in job.get("actions", []):
            builder.add_action(act)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            output_path.unlink()

        builder.sign_file(str(asset_path), str(output_path), signer)

        bytes_out = output_path.stat().st_size
        print(json.dumps({
            "ok": True,
            "output_path": str(output_path),
            "bytes": bytes_out,
            "signing_mode": signing_mode(),
            "signer_identity": signer_identity(),
        }))
        return 0
    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": f"sign failed: {e}",
            "trace": traceback.format_exc().splitlines()[-6:],
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
