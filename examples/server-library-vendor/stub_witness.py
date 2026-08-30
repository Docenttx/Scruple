"""A stand-in for scruple.ai's /api/v2 surface, on a loopback port.

NOT A MOCK LIBRARY — the model is `services/cvm-surrogate/`, and the reason
is the same: it speaks the real protocol over a real socket, and what makes
it safe is that everything it emits is visibly a stub. A vendor pointed at
it exercises the same `http.submit()` path, the same queue-on-failure
behaviour and the same MAC that production exercises.

WHY A STUB AT ALL, when the real route exists in this repo: the real route
is a Next.js handler that needs the whole app, a database and a witness
server. A vendor evaluating the integration should not need any of those to
see a leaf come out, and an example that cannot be run is not a reference.

WHAT IT REPRODUCES FAITHFULLY
  * the D-3 baseline handshake — GET /baseline/current 404s, POST creates;
  * H-4 §4.4 provisioning — derives IK = HKDF(BDK, component_id) from a
    published dev BDK and returns it exactly once;
  * H-4 §4.2 verification — recomputes the MAC over
    `component_preimage(body)`, the SAME function the component called, and
    REFUSES a bad one. A stub that accepted any MAC would teach a vendor
    that their MAC works.
  * §10 C-6 — it will not verify anything before checking the bearer token,
    for the same reason the real route will not.
  * gap accounting — a counter arriving above the high-water mark records
    the skipped ones.

WHAT IT DOES NOT
  * no Merkle chain, no signature over the leaf, no persistence. The leaf it
    returns is shaped like the real one and is not anchored to anything.
  * `witnessed: true` here means "this stub verified your MAC", which is
    strictly less than what production means by it.

THE BDK IS PUBLISHED IN THIS FILE. That is deliberate and it is the same
choice `lib/ratchet/bdk.ts` makes for its dev constant: a dev key that looks
like a secret is worse than one that obviously is not, because somebody
eventually ships it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

sys.path[:0] = [
    os.path.join(os.path.dirname(__file__), "..", "..", "packages", "scruple-api"),
    os.path.join(os.path.dirname(__file__), "..", "..", "packages", "scruple-host-sdk"),
]

from scruple_host_sdk.ratchet import (  # noqa: E402
    INFO_MAC,
    canonical_preimage,
    derive_ik,
    hkdf_expand,
)
from scruple_host_sdk.server_library import component_preimage  # noqa: E402

# bytes(range(32)) — test/vectors/ratchet-vectors.json's obvious test key.
STUB_BDK = bytes(range(32))
STUB_API_KEY = "sk_stub_server_library_demo"

_lock = threading.Lock()
_baselines: Dict[str, str] = {}
_components: Dict[str, Dict[str, Any]] = {}
_tokens: Dict[str, str] = {}
_leaf_seq = [0]

#: Every event this stub verified, for the demo to report on.
verified_events: list = []


def issue_provisioning_token(component_id: str, token: str) -> None:
    _tokens[token] = component_id


def _mac_at(component_id: str, counter: int, blob: bytes) -> str:
    """Re-derive K_n from the BDK and MAC. The server can do this for any
    counter because it holds the BDK; the component cannot, because it
    holds only K_n and the chain is one-way."""
    k = bytes(derive_ik(STUB_BDK, component_id))
    for _ in range(counter):
        k = hkdf_expand(k, b"scruple/ratchet/v1", 32)
    m = hkdf_expand(k, INFO_MAC, 32)
    return hmac.new(m, blob, hashlib.sha256).hexdigest()


class Handler(BaseHTTPRequestHandler):
    server_version = "ScrupleStubWitness/1.0"
    quiet = True

    def log_message(self, fmt: str, *args: Any) -> None:
        if not self.quiet:
            sys.stderr.write(f"[stub-witness] {fmt % args}\n")

    def _json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # One header a caller can check to refuse to talk to a stub.
        self.send_header("X-Scruple-Stub-Witness", "1")
        self.end_headers()
        self.wfile.write(body)

    def _principal(self) -> Optional[str]:
        """§10 C-6: NOTHING happens before this returns."""
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            return None
        return "vendor-acme" if auth[7:].strip() == STUB_API_KEY else None

    def _read(self) -> Dict[str, Any]:
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path == "/health":
            self._json(200, {"ok": True, "stub": True})
            return
        tenant = self._principal()
        if tenant is None:
            self._json(401, {"error": {"code": "unauthorized", "message": "Bearer key required."}})
            return
        if path == "/api/v2/baseline/current":
            ref = _baselines.get(tenant)
            if not ref:
                self._json(404, {"error": {"code": "not_found", "message": "no baseline"}})
            else:
                self._json(200, {"baseline_ref": ref})
            return
        self._json(404, {"error": {"code": "not_found", "message": path}})

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/") or "/"

        # AUTHENTICATE FIRST. On the witness route this is C-6: the counter
        # below travels in the clear, and ratcheting to it is work
        # proportional to it. Doing that for an unauthenticated caller is
        # the DoS primitive C-6 exists to remove.
        tenant = self._principal()
        if tenant is None:
            self._json(401, {"error": {"code": "unauthorized", "message": "Bearer key required."}})
            return

        body = self._read()

        if path == "/api/v2/baseline":
            with _lock:
                _baselines[tenant] = body["tamper_surface_hash"]
            self._json(201, {"baseline_ref": body["tamper_surface_hash"]})
            return

        if path == "/api/v2/components/provision":
            token = body.get("token")
            component_id = _tokens.pop(token, None)  # single use
            if component_id is None:
                self._json(404, {"error": {"code": "not_found", "message": "no usable token"}})
                return
            with _lock:
                _components[component_id] = {
                    "tenant_id": tenant,
                    "build_measurement": body["build_measurement"],
                    "last_counter": None,
                }
            self._json(
                201,
                {
                    "component_id": component_id,
                    "tenant_id": tenant,
                    "ik_hex": bytes(derive_ik(STUB_BDK, component_id)).hex(),
                    "counter": 0,
                    "build_measurement": body["build_measurement"],
                    # H-5. `passthrough` is not a lesser grade of
                    # compliance; it is this leaf declaring what backed it.
                    "attestation": {"status": "passthrough"},
                },
            )
            return

        if path == "/api/v2/witness":
            self._witness(tenant, body)
            return

        self._json(404, {"error": {"code": "not_found", "message": path}})

    def _witness(self, tenant: str, body: Dict[str, Any]) -> None:
        if body.get("baseline_ref") != _baselines.get(tenant):
            self._json(409, {"error": {"code": "baseline_required", "message": "unknown baseline"}})
            return

        component_verified = False
        gap = 0
        comp = body.get("component")
        if comp:
            row = _components.get(comp["component_id"])
            if row is None or row["tenant_id"] != tenant:
                self._json(422, {"error": {"code": "component_unverified", "message": "unknown component"}})
                return
            # ONE function builds the preimage and the component called the
            # same one. A server that reconstructed the field set by hand
            # would have a MAC that verifies whatever the server assembled.
            blob = canonical_preimage(component_preimage(body))
            expected = _mac_at(comp["component_id"], comp["counter"], blob)
            if not hmac.compare_digest(expected, body.get("mac", "")):
                self._json(
                    422,
                    {
                        "error": {
                            "code": "component_unverified",
                            "message": "MAC does not verify against the key this component would hold.",
                            "detail": {"reason": "bad_mac"},
                        }
                    },
                )
                return
            last = row["last_counter"]
            if last is not None and comp["counter"] > last + 1:
                gap = comp["counter"] - last - 1
            if last is None or comp["counter"] > last:
                row["last_counter"] = comp["counter"]
            component_verified = True
            verified_events.append({"counter": comp["counter"], "gap": gap})

        _leaf_seq[0] += 1
        leaf_id = str(_leaf_seq[0])
        self._json(
            201,
            {
                "leaf_id": leaf_id,
                "leaf_hash": hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(),
                # 201 means CAPTURED. It has never meant witnessed.
                "witnessed": component_verified,
                "witness_id": f"wit_stub_{leaf_id}",
                "leaf_scheme": "v2",
                "run_sequence": _leaf_seq[0],
                "baseline_ref": body["baseline_ref"],
                "mime": body.get("mime"),
                "mime_declared": bool(body.get("mime")),
                "component": (
                    {
                        "component_id": comp["component_id"],
                        "counter": comp["counter"],
                        "verified": component_verified,
                        "gap": gap,
                    }
                    if comp
                    else None
                ),
                "component_verified": component_verified,
            },
        )


def start(port: int = 0) -> Tuple[ThreadingHTTPServer, str]:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


if __name__ == "__main__":
    srv, url = start(int(os.environ.get("STUB_WITNESS_PORT", "8811")))
    print(f"[stub-witness] {url}  (api key: {STUB_API_KEY})")
    srv.serve_forever()
