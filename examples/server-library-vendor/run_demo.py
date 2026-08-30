#!/usr/bin/env python3
"""The worked reference integration, end to end, in four scenarios.

    python3 examples/server-library-vendor/run_demo.py

Starts the CVM surrogate (services/cvm-surrogate, port 8799) if it is not
already answering, starts a stub witness on a loopback port, and runs:

  1. THE HAPPY PATH — a leaf, an envelope, and a third party verifying it.
  2. THE WITNESS IS UNREACHABLE — queue, drain, counter preserved.
  3. THE PLACEMENT DOES NOT PERMIT THE CLAIM — the same vendor's
     custom-handler configuration, refused before a counter is spent.
  4. A TAMPERED SUBMISSION — the MAC refuses it, so the stub is not
     teaching you that your MAC works.

Scenario 1 prints the assurance tier in full, because the tier is the thing
a vendor gets wrong: `server-library` earns P1 for free and STILL produces
only a `passthrough` leaf. That is PLACEMENT_AND_SURFACES.md §5.2's
top-right cell and it is not a limitation of this demo — nothing lifts a
leaf to `verified` except an attestation chained to a vendor root, and no
verifier plugin in the estate can produce one.

Exit status is non-zero if any scenario does not do what it says.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path[:0] = [
    os.path.join(REPO, "packages", "scruple-api"),
    os.path.join(REPO, "packages", "scruple-host-sdk"),
    HERE,
]

import kms_signer  # noqa: E402
import stub_witness  # noqa: E402
import vendor_backend  # noqa: E402
from scruple_api.surface import PlacementEnforcement  # noqa: E402
from scruple_host_sdk.envelope import open_leaf_attestation  # noqa: E402
from scruple_host_sdk.server_library import PlacementRefused  # noqa: E402

BUILD = "sha256:" + "ab" * 32
FAILURES: list = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"    {'PASS' if condition else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    if not condition:
        FAILURES.append(label)


def rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def start_surrogate() -> None:
    if kms_signer.health():
        print("[demo] CVM surrogate already answering on 127.0.0.1:8799")
        return
    keydir = tempfile.mkdtemp(prefix="scruple-surrogate-")
    atexit.register(shutil.rmtree, keydir, True)
    env = {**os.environ, "SURROGATE_KEY_PATH": os.path.join(keydir, "key.pem")}
    proc = subprocess.Popen(
        [sys.executable, os.path.join(REPO, "services", "cvm-surrogate", "surrogate.py")],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    atexit.register(proc.terminate)
    for _ in range(50):
        if kms_signer.health():
            print("[demo] started the CVM surrogate on 127.0.0.1:8799")
            return
        time.sleep(0.1)
    raise SystemExit(
        "[demo] the CVM surrogate did not come up. Start it by hand:\n"
        "         python3 services/cvm-surrogate/surrogate.py"
    )


def attach(workdir: str, *, base_url: str, enforcement=PlacementEnforcement.NO_TENANT_CODE):
    component_id = str(uuid.uuid4())
    token = f"tok_{uuid.uuid4().hex}"
    stub_witness.issue_provisioning_token(component_id, token)
    return vendor_backend.attach(
        base_url=base_url,
        api_key=stub_witness.STUB_API_KEY,
        provisioning_token=token,
        build_measurement=BUILD,
        seal_path=os.path.join(workdir, "component.seal"),
        envelope_signers=[kms_signer.signer()],
        enforcement=enforcement,
    )


def main() -> int:
    start_surrogate()
    _srv, witness_url = stub_witness.start()
    print(f"[demo] stub witness on {witness_url}")

    root = tempfile.mkdtemp(prefix="scruple-server-library-demo-")
    atexit.register(shutil.rmtree, root, True)
    artifact = os.path.join(root, "render.png")
    with open(artifact, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"pretend-image-bytes" * 64)

    # ---------------------------------------------------------------- 1
    rule("1 · THE HAPPY PATH — a leaf, an envelope, and a third party checking it")
    w1 = os.path.join(root, "worker-1")
    os.makedirs(w1)
    integ = attach(w1, base_url=witness_url)

    a = integ.assurance()
    print(f"\n  placement declared   {integ.resolution.declared.value}")
    print(f"  enforcement          {integ.resolution.enforcement.value}")
    print(f"  placement effective  {integ.resolution.effective.value}")
    print(f"  attestation outcome  {a.attestation.value}")
    print(f"  P1                   {a.p1.value}")
    print(f"  P3                   {a.p3.value}")
    print(f"  LEAF TIER            {a.leaf}")
    print(f"  can claim            {a.can_claim}")
    print(f"\n  {a.reason}\n")

    outcome = vendor_backend.handle_request(integ, artifact, "image/png")
    print(f"  leaf_id     {outcome.leaf_id}")
    print(f"  leaf_hash   {outcome.leaf_hash}")
    print(f"  counter     {outcome.counter}")
    print(f"  mac         {outcome.mac}")
    print(f"  witnessed   {outcome.witnessed}")
    print(f"  leaf_status {outcome.leaf_status}")

    check("the witness verified the component's MAC", outcome.witnessed is True)
    check("a counter was spent, exactly once", outcome.counter == 0 and integ.ratchet.counter == 1)
    check(
        "the tier is passthrough, NOT verified — §5.2's top-right cell",
        outcome.leaf_status == "passthrough",
        "P1 is free at server-library and buys no tier at all",
    )
    check("the predicate's derived posture agrees", outcome.predicate["leaf_status"] == "passthrough")
    check("p1 holds and is DERIVED, not declared", outcome.predicate["properties"]["p1"] == "holds")

    # A third party, holding only the envelope and the vendor's public key.
    opened = open_leaf_attestation(outcome.envelope, [kms_signer.verifier()])
    check("the DSSE envelope verifies against the vendor's published key", True)
    check(
        "the leaf came back out verbatim",
        json.dumps(opened.leaf) == json.dumps(outcome.leaf),
        "the envelope wraps; it does not reshape",
    )
    check(
        "the subject digest is the artifact's own sha256",
        opened.statement["subject"][0]["digest"]["sha256"] == outcome.content_hash,
        "re-derivable by anyone holding the bytes — not a hash of the leaf object",
    )
    check(
        "the predicate rode inside and says passthrough",
        opened.predicate["leaf_status"] == "passthrough",
    )

    tampered = json.loads(json.dumps(outcome.envelope))
    tampered["signatures"][0]["sig"] = tampered["signatures"][0]["sig"][:-4] + "AAAA"
    try:
        open_leaf_attestation(tampered, [kms_signer.verifier()])
        check("a tampered signature is refused", False)
    except Exception:
        check("a tampered signature is refused", True)

    # ---------------------------------------------------------------- 2
    rule("2 · THE WITNESS IS UNREACHABLE — queue, drain, counter preserved")
    w2 = os.path.join(root, "worker-2")
    os.makedirs(w2)
    integ2 = attach(w2, base_url=witness_url)
    # Point the client at a port nothing is listening on. This is what a
    # vendor sees during an outage; note there is no try/except anywhere in
    # vendor_backend.py, because http.submit() enqueues inside its own
    # control flow (CANON_SKELETON.md §5 property 3).
    good_url, integ2.client.base_url = integ2.client.base_url, "http://127.0.0.1:1"

    q1 = vendor_backend.handle_request(integ2, artifact, "image/png")
    q2 = vendor_backend.handle_request(integ2, artifact, "image/png")
    print(f"  first  queued={q1.queued} counter={q1.counter} envelope={q1.envelope}")
    print(f"  second queued={q2.queued} counter={q2.counter} depth={integ2.queue_depth}")

    check("the event is durably queued, not lost", q1.queued is True and integ2.queue_depth == 2)
    check(
        "the counter was spent anyway — derive, MAC, ratchet, THEN enqueue (§5)",
        q1.counter == 0 and q2.counter == 1,
    )
    check(
        "capture did NOT block on the queue head",
        q2.counter == 1,
        "one undeliverable event must not silence a component — silence is what the design makes visible",
    )
    check(
        "no envelope was minted for an event the witness never saw",
        q1.envelope is None,
        "attesting it would assert something that did not happen",
    )

    integ2.client.base_url = good_url
    drained = integ2.drain()
    print(f"  drained: {drained}")
    check("the queue drained on reconnect", drained["succeeded"] == 2 and integ2.queue_depth == 0)
    counters = [e["counter"] for e in stub_witness.verified_events[-2:]]
    check(
        "the drained events carried their ORIGINAL counters",
        counters == [0, 1],
        f"the witness saw {counters} — a re-MAC would have meant two counters for one event",
    )

    # ---------------------------------------------------------------- 3
    rule("3 · THE PLACEMENT DOES NOT PERMIT THE CLAIM — the custom-handler configuration")
    print(
        "\n  Same vendor, same code, same SDK. This configuration also offers a customer\n"
        "  handler.py, so tenant code runs in the capture process and `no-tenant-code`\n"
        "  is false. PLACEMENT_AND_SURFACES.md §7.3: a vendor is not a placement; a\n"
        "  CONFIGURATION is, and a custom-handler feature silently revokes the free P1.\n"
    )
    w3 = os.path.join(root, "worker-3")
    os.makedirs(w3)
    integ3 = attach(w3, base_url=witness_url, enforcement=PlacementEnforcement.NONE)
    a3 = integ3.assurance()
    print(f"  placement declared   {integ3.resolution.declared.value}")
    print(f"  enforcement          {integ3.resolution.enforcement.value}")
    print(f"  placement effective  {integ3.resolution.effective.value}")
    print(f"  P1                   {a3.p1.value}")
    print(f"  P3                   {a3.p3.value}")
    print(f"  LEAF TIER            {a3.leaf}")
    print(f"  can claim            {a3.can_claim}")
    print(f"\n  {integ3.resolution.reason}\n")

    before = integ3.ratchet.counter
    try:
        vendor_backend.handle_request(integ3, artifact, "image/png")
        check("witnessing is refused at this placement", False)
    except PlacementRefused as e:
        check("witnessing is refused at this placement", True)
        print(f"  {str(e).splitlines()[0]}")
    check(
        "no counter was spent on the refusal",
        integ3.ratchet.counter == before,
        "a refusal must not cost a counter the component can never account for",
    )
    check("no leaf may be issued at all", a3.leaf is None and a3.can_claim is False)

    # ---------------------------------------------------------------- 4
    rule("4 · A TAMPERED SUBMISSION — the witness refuses it")
    print(
        "\n  A stub that accepted any MAC would teach a vendor that their MAC works.\n"
        "  This one recomputes it over component_preimage(body) — the same function the\n"
        "  component called — and refuses a body that changed in flight.\n"
    )
    import urllib.error
    import urllib.request

    from scruple_host_sdk.ratchet import canonical_preimage
    from scruple_host_sdk.server_library import component_preimage

    w4 = os.path.join(root, "worker-4")
    os.makedirs(w4)
    integ4 = attach(w4, base_url=witness_url)
    good = vendor_backend.handle_request(integ4, artifact, "image/png")
    check("the honest submission verified", good.witnessed is True)

    # Replay the same MAC over a changed content_hash — the shape a proxy
    # rewriting a response would produce.
    forged = {
        "baseline_ref": integ4.client.state.baseline_ref,
        "kind": "artifact",
        "content_hash": "f" * 64,
        "mime": "image/png",
        "capture": {
            "surface": "in-process-callback",
            "hook": "artifact.produced",
            "fidelity": "as-delivered",
            "size_bytes": None,
            "mime_source": None,
            "correlation_id": None,
            "correlation_method": None,
            "egress": None,
            "close_detection": None,
            "workflow_hash": None,
            "observed_at": "2026-08-30T00:00:00.000Z",
            "attestation_status": "passthrough",
        },
        "component": {
            "component_id": integ4.component.component_id,
            "build_measurement": BUILD,
            "counter": 1,
            "attestation": {"provider": "none", "quote_ref": None},
        },
        "mac": good.mac,
    }
    req = urllib.request.Request(
        witness_url + "/api/v2/witness",
        data=json.dumps(forged).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {stub_witness.STUB_API_KEY}",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        check("a forged submission is refused", False)
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read())
        check("a forged submission is refused", e.code == 422, f"{e.code} {detail['error']['message'][:60]}")

    # An unauthenticated submission never reaches verification at all (C-6).
    req2 = urllib.request.Request(
        witness_url + "/api/v2/witness",
        data=json.dumps(forged).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req2, timeout=5)
        check("an unauthenticated submission is 401 before any verification", False)
    except urllib.error.HTTPError as e:
        check("an unauthenticated submission is 401 before any verification", e.code == 401)

    rule("SUMMARY")
    if FAILURES:
        print(f"  {len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            print(f"    - {f}")
        return 1
    print(
        "  All checks passed.\n\n"
        "  The tier this integration earns is `passthrough`. That is not a shortcoming of\n"
        "  the demo and it is not fixed by writing more integration code: a `verified`\n"
        "  leaf requires an attestation chained to a vendor root, which is a property of\n"
        "  the COMPUTE, and no verifier plugin in the estate produces one today.\n"
        "  PLACEMENT_AND_SURFACES.md §5.2, top-right cell."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
