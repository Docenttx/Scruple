#!/usr/bin/env python3
"""Read a signed asset back through c2pa.Reader and print what it says.

Prints ONE JSON object:
  {"validation_state": "...", "failure_codes": [...], "signature_info": {...}}

`validation_state` is get_validation_state(), NOT is_valid(). is_valid() is
unreliable across c2pa-python builds -- it has answered True for a manifest
whose validation results carried claimSignature.mismatch. The state enum is
the value c2pa-rs itself computes: Invalid / Valid / Trusted.

`failure_codes` is every code under validation_results.*.failure[].code, which
is where `claimSignature.mismatch` and `signingCredential.untrusted` live.
"""
import json
import sys


def main() -> int:
    path = sys.argv[1]
    out = {"asset": path}
    try:
        import c2pa
    except Exception as e:  # pragma: no cover - environment fault
        print(json.dumps({"error": f"c2pa import failed: {e}"}))
        return 2
    try:
        with open(path, "rb") as f:
            reader = c2pa.Reader("image/png", f)
            out["validation_state"] = str(reader.get_validation_state())
            results = reader.get_validation_results()
            codes = []
            def walk(node):
                if isinstance(node, dict):
                    for k, v in node.items():
                        if k == "failure" and isinstance(v, list):
                            for item in v:
                                if isinstance(item, dict) and item.get("code"):
                                    codes.append(item["code"])
                        else:
                            walk(v)
                elif isinstance(node, list):
                    for item in node:
                        walk(item)
            walk(results if isinstance(results, dict) else json.loads(results or "{}"))
            out["failure_codes"] = sorted(set(codes))
            manifest = json.loads(reader.json())
            active = manifest.get("manifests", {}).get(
                manifest.get("active_manifest", ""), {}
            )
            out["signature_info"] = active.get("signature_info", {})
            out["claim_generator"] = active.get("claim_generator")
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
