#!/usr/bin/env python3
"""WO-B6 mutation sweep. Break one thing, name the test that must catch it,
revert. A test that stays green under its own mutation is not a test."""
import subprocess, sys

ADDON = "/data/scruple-blender"
WEB = "/data/scruple-web"

M = [
    # (file, old, new, test that MUST fail, label)
    (f"{ADDON}/adapter/assurance.py",
     '    nested = receipt.get("signature")\n    if isinstance(nested, dict):',
     '    nested = receipt.get("signature")\n    if False:',
     "tests/test_signature_check.py::test_the_nested_disclosure_is_read",
     "the nested S1 disclosure is ignored again"),

    (f"{ADDON}/adapter/assurance.py",
     "        pub.verify(\n            base64.b64decode(sig.leaf_signature),\n            bytes.fromhex(rec.leaf_hash),\n            _ec.ECDSA(_h.SHA256()),\n        )",
     "        base64.b64decode(sig.leaf_signature)",
     "tests/test_signature_check.py::test_CONTROL_a_tampered_signature_is_REJECTED",
     "check_signature never calls verify -- it just decodes the base64"),

    (f"{ADDON}/adapter/assurance.py",
     "        if isinstance(e, InvalidSignature):\n            ok, note = False,",
     "        if True:\n            ok, note = False,",
     "tests/test_signature_check.py::test_CONTROL_an_unreachable_key_server_does_not_accuse_the_leaf",
     "a network outage is reported as a bad signature"),

    (f"{ADDON}/adapter/assurance.py",
     '        if self.signature.checked_ok is False:\n            return "SIGNATURE DID NOT VERIFY"',
     '        if False:\n            return "SIGNATURE DID NOT VERIFY"',
     "tests/test_signature_check.py::test_CONTROL_a_tampered_signature_is_REJECTED",
     "a failed check no longer changes the tier"),

    (f"{ADDON}/adapter/assurance.py",
     "        independently_verifiable_checked=rec.independently_verifiable_checked,",
     "        independently_verifiable_checked=False,",
     "tests/test_signature_check.py::test_CONTROL_verification_claim_does_not_erase_the_clients_verdict",
     "the server's claim zeroes the client's own check"),

    (f"{ADDON}/adapter/assurance.py",
     '        if self.signature.state == "unsigned":\n            return "unsigned (Scruple audit record only)"',
     '        if False:\n            return "unsigned (Scruple audit record only)"',
     "tests/test_signature_check.py::test_CONTROL_unsigned_is_not_undisclosed_and_not_passthrough",
     "`unsigned` collapses back into the generic tier"),

    (f"{ADDON}/vendor/scruple_host_sdk/http.py",
     "    if scheme not in allowed_schemes:",
     "    if False:",
     "tests/test_signature_check.py::test_the_key_fetch_refuses_a_file_url",
     "the key fetch accepts file://"),

    (f"{ADDON}/vendor/scruple_host_sdk/http.py",
     '        headers={"Accept": "application/x-pem-file, */*", "User-Agent": USER_AGENT},',
     '        headers={"Accept": "*/*", "User-Agent": USER_AGENT, "Authorization": f"Bearer {getattr(session, chr(97)+chr(112)+chr(105)+chr(95)+chr(107)+chr(101)+chr(121), None)}"},',
     "tests/test_signature_check.py::test_the_key_fetch_sends_no_api_key",
     "the key fetch forwards the tenant API key"),
]


def run(test):
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", test],
                       cwd=ADDON, capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr).strip().splitlines()[-1]


print("baseline: the whole addon suite")
r = subprocess.run([sys.executable, "-m", "pytest", "-q"], cwd=ADDON, capture_output=True, text=True)
print("  " + (r.stdout + r.stderr).strip().splitlines()[-1])
if r.returncode != 0:
    sys.exit("baseline is not green; refusing to sweep")

bad = 0
for path, old, new, test, label in M:
    src = open(path).read()
    if old not in src:
        print(f"SKIP  {label}\n      anchor not found in {path}")
        bad += 1
        continue
    open(path, "w").write(src.replace(old, new, 1))
    try:
        passed, last = run(test)
    finally:
        open(path, "w").write(src)
    caught = not passed
    if not caught:
        bad += 1
    print(f"{'CAUGHT' if caught else 'MISSED'}  {label}\n"
          f"        {test.split('::')[-1]}\n        -> {last}")

# and the tree is back
passed, last = run("")
print(f"\nafter revert, whole suite: {last}")
sys.exit(0 if bad == 0 and passed else 1)
