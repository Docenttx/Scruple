#!/usr/bin/env python3
"""Scruple C2PA signer — subprocess entry point.

Reads a JSON job spec from stdin, signs the asset, writes the signed
asset to disk, prints a JSON result to stdout.

Job spec:
    {
        "asset_path": "/tmp/thumb.png",
        "output_path": "/tmp/thumb.c2pa.png",
        "cert_path":   ".../keys/signer.pem",  # leaf + root chain PEM
        "key_path":    ".../keys/signer.key",  # LOCAL MODE ONLY — ignored
                                               # in Vault mode. Optional:
                                               # when omitted, vault_sign.
                                               # local_key_path() resolves
                                               # the same default.
        "manifest": {
            "claim_generator": "Scruple/0.1",   # Signer appends the
                                                 # real c2pa-python version
            "format": "image/png",
            "title": "MyDesign",
            "assertions": [...]           # non-c2pa assertions only
        },
        "intent": "CREATE",               # C2paBuilderIntent name;
                                          # defaults to CREATE
        "digital_source_type":            # C2paDigitalSourceType name.
            "DIGITAL_CREATION",           # REQUIRED — no default. See
                                          # the note below.
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

digital_source_type is REQUIRED and has no default.

It used to default to TRAINED_ALGORITHMIC_MEDIA, and lib/c2pa/signAsset.ts
carried the same fallback, and no plugin path overrode either. The plugin
market is proof that an artifact was made WITHOUT generative AI — Fusion,
Blender, Meshroom and Toon Boom run no inference — so the default wrote
the opposite claim into a signed, third-party-verifiable manifest. A
false signed claim, not a cosmetic field. Latent on Fusion (no CAD MIME
is C2PA-signable today), live on Blender's PNG/JPEG renders.

So this file now refuses rather than guesses, the same posture as
assertion_partition.py's fail-closed allowlist and capture()'s explicit
`mime` in packages/scruple-host-sdk. The caller made the asset and knows
how; the Signer does not. Correct values, with the URIs c2pa 0.36.0
actually emits (verified by signing and reading back, not by reading the
enum):

    TRAINED_ALGORITHMIC_MEDIA
      http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia
      GenAI output — the canvas / ComfyUI / Modal flow.
    DIGITAL_CREATION
      http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation
      IPTC "Digital creation": media created by a human using
      non-generative tools. Every plugin host.

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

    # digital_source_type is checked HERE — at job-spec parse time,
    # before the SDK loads, before the age and patch guards run, before
    # anything touches the asset. It is not a signing detail that can be
    # filled in later; it is the caller's declaration of whether
    # generative AI made these bytes, and without it there is nothing
    # honest to sign. The enum-name lookup happens further down, where
    # c2pa is imported.
    dst_name = job.get("digital_source_type")
    if not isinstance(dst_name, str) or not dst_name.strip():
        print(json.dumps({
            "ok": False,
            "error": (
                "job spec requires an explicit digital_source_type and the "
                "Signer will not guess one. There is no default: a default "
                "of TRAINED_ALGORITHMIC_MEDIA signs a claim that generative "
                "AI made this asset, which is the opposite of what the "
                "plugin hosts exist to prove. Use TRAINED_ALGORITHMIC_MEDIA "
                "for GenAI output, DIGITAL_CREATION for a human working in "
                "a non-generative tool (CAD, 3D, animation). "
                f"Got: {dst_name!r}."
            ),
        }))
        return 1
    dst_name = dst_name.strip()

    # Format gate. The declared MIME is checked against the one registry
    # (formats.py) BEFORE the SDK loads, so an unsignable format comes
    # back as a named refusal instead of a c2pa-rs exception that reaches
    # the caller as a 500. WebM was the live case: mimeFromPath routed
    # .webm to video/webm, c2pa-rs has no WebM handler, and a txt2vid
    # output got a crash rather than an answer.
    #
    # Enforced here as well as in lib/c2pa/formats.ts because this is the
    # end that owns the library, and a second caller of sign.py must not
    # be able to reach c2pa-rs with a format the registry refuses.
    try:
        HERE = Path(__file__).resolve().parent
        if str(HERE) not in sys.path:
            sys.path.insert(0, str(HERE))
        from formats import refusal_reason
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"formats import failed: {e}"}))
        return 1
    declared_mime = (manifest.get("format") or "").strip()
    if not declared_mime:
        print(json.dumps({
            "ok": False,
            "code": "unsupported_format",
            "error": (
                "manifest.format is required. sign_file()'s extension "
                "sniffing mis-maps .flac and fails outright on .jxl, so the "
                "MIME is always passed explicitly — which means the caller "
                "has to declare it."
            ),
        }))
        return 1
    _refusal = refusal_reason(declared_mime)
    if _refusal:
        print(json.dumps({
            "ok": False,
            "code": "unsupported_format",
            "error": _refusal,
        }))
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
        from signer_runtime import age_guard_verdict, runtime_assertion
        from os_patch_check import patch_recency_verdict
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"vault_sign import failed: {e}"}))
        return 1

    # L2 age guard — refuse to sign if the running CVM has aged past the
    # max-age policy. Defense-in-depth alongside the OCI rotation Function
    # that terminates aged instances.
    # On dev/non-OCI hosts (IMDS unreachable), age_guard_verdict returns
    # refuse=False and signing proceeds normally.
    guard = age_guard_verdict()
    if guard["refuse"]:
        print(json.dumps({
            "ok": False,
            "error": "signer age guard refused sign",
            "guard": guard,
        }))
        return 1

    # L2 OS patch recency guard — refuse to sign if the last package
    # install/upgrade on the running OS is > 90 days old (SCRUPLE_OS_PATCH_MAX_AGE_DAYS).
    # This satisfies C2PA GPSR §6.3.2 and §6.4.2 by extracting the actual OS
    # patch-level date from dnf/apt history rather than relying on instance
    # age as a proxy. Fail-closed in production; permissive on dev where
    # detection may not be available.
    patch_guard = patch_recency_verdict()
    if patch_guard["refuse"]:
        print(json.dumps({
            "ok": False,
            "error": "os patch recency guard refused sign",
            "patch_guard": patch_guard,
        }))
        return 1

    # c2pa settings.
    #
    # builder.created_assertion_labels: c2pa-rs v2 defaults non-hash
    # assertions to gathered_assertions unless the label appears in this
    # list. Without it, our c2pa.actions.v2 and c2pa.thumbnail.claim land
    # in the gathered bucket, which is wrong per the C2PA v2 spec (they
    # should be in created). Fix confirmed against c2pa-rs
    # sdk/src/claim.rs::claim_assertion_type + CAI opensource docs on
    # created-vs-gathered assertions. Labels are base labels (no .vN).
    #
    # verify.*: dev-mode relaxation, only when SCRUPLE_C2PA_DEV=1 exactly.
    # The prod systemd unit sets SCRUPLE_C2PA_DEV="" (empty), which fails
    # the equality check.
    _settings = {
        "builder": {
            "created_assertion_labels": [
                "c2pa.actions",
                "c2pa.thumbnail.claim",
                "c2pa.thumbnail.ingredient",
                "c2pa.ingredient",
            ],
        },
    }
    if os.environ.get("SCRUPLE_C2PA_DEV") == "1":
        _settings["verify"] = {
            "verify_after_sign": False,
            "verify_trust": False,
        }
    try:
        c2pa.load_settings(json.dumps(_settings), "json")
    except Exception:
        pass  # older SDKs may not support all keys

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

        # Stamp the REAL installed c2pa-python version into claim_generator.
        # The Application tier sends a bare "Scruple/0.1"; only the Signer
        # knows which SDK build actually produced the manifest, and a
        # reviewer inspecting a signed asset is entitled to the true
        # version. The previous hardcoded "c2pa-python 0.89" names a
        # version that has never been published — it was scrubbed from the
        # Bundle Instructions on 2026-08-05 but survived in the manifest
        # builder, where it reached every signed asset.
        try:
            import c2pa as _c2pa_mod
            _sdk_ver = getattr(_c2pa_mod, "__version__", None)
        except Exception:
            _sdk_ver = None
        if _sdk_ver:
            _cg = str(manifest.get("claim_generator") or "Scruple/0.1")
            if "c2pa-python" not in _cg:
                manifest["claim_generator"] = f"{_cg} (c2pa-python {_sdk_ver})"

        # Assertion partition — enforce the TOE boundary per GPSA §C.2.4.
        # The Client is authenticated but its manifest payload is treated
        # as untrusted input: any label the Client submits that isn't on
        # the CREATED_ALLOWLIST is moved to a `gathered_assertions` block
        # (or rejected outright if unrecognized). This prevents an external
        # caller from ever having assertions of external provenance land
        # in `created_assertions`.
        try:
            from assertion_partition import partition_assertions
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"assertion_partition import failed: {e}"}))
            return 1

        partitioned, partition_audit = partition_assertions(
            manifest.get("assertions") or []
        )
        manifest["assertions"] = partitioned["created"]
        if partitioned["gathered"]:
            manifest["gathered_assertions"] = (
                (manifest.get("gathered_assertions") or []) + partitioned["gathered"]
            )

        # Inject ai.scruple.signer-runtime.v1 assertion into the manifest.
        # This is a Scruple-authored assertion constructed inside the TOE
        # from IMDS metadata — belongs in created_assertions per GPSA
        # §C.2.4 (it describes the signing environment itself). Omitted on
        # dev/non-OCI hosts where IMDS is unreachable.
        runtime_ass = runtime_assertion()
        if runtime_ass is not None:
            manifest["assertions"].append(runtime_ass)
            partition_audit["scruple_runtime_added"] = True

        # Emit the partition audit line for §C.2.6 audit surface.
        try:
            sys.stderr.write(
                "[c2pa-signer] assertion_partition_audit=" +
                json.dumps(partition_audit, sort_keys=True) + "\n"
            )
            sys.stderr.flush()
        except Exception:
            pass

        builder = c2pa.Builder(manifest)

        # Intent + digitalSourceType — SDK emits the inception action
        # (c2pa.created or c2pa.opened depending on intent) first, with
        # the required digitalSourceType field.
        intent_name = job.get("intent", "CREATE")
        # Already validated as present and non-empty at job-spec parse
        # time. No `job.get(..., default)` here or anywhere: an absent
        # digital_source_type is the caller declining to say whether
        # generative AI was involved, and the only honest manifest to
        # emit in that case is none at all.
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

        # Stream-sign with the caller-declared MIME (from manifest["format"]).
        # sign_file() infers the MIME from the file extension, which mis-maps
        # .flac to audio/x-flac (unsupported by c2pa-rs; audio/flac is the
        # supported form) and fails MIME detection entirely for .jxl. Passing
        # the MIME explicitly avoids both bugs — the caller already declared
        # it in the manifest, so we're not guessing.
        asset_mime = manifest.get("format") or ""
        with open(asset_path, "rb") as src, open(output_path, "wb") as dst:
            builder.sign(signer, asset_mime, src, dst)

        bytes_out = output_path.stat().st_size
        print(json.dumps({
            "ok": True,
            "output_path": str(output_path),
            "bytes": bytes_out,
            "signing_mode": signing_mode(),
            "signer_identity": signer_identity(),
            "signer_age_guard": guard,
            "os_patch_guard": patch_guard,
            "assertion_partition": partition_audit,
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
