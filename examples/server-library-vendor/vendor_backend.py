"""What a vendor writes. All of it.

This is the artifact a Hugging-Face-shaped vendor is actually handed, so it
is deliberately the shortest file in this directory. Everything below the
INTEGRATION block is a stand-in for the vendor's own inference stack and is
not part of what they have to write.

THE SHAPE, IN ONE SENTENCE: once at startup you attach a baseline and
provision a component; once per produced artifact you call `witness_file()`
or `witness()`; and you print the tier, because the tier is not what a
vendor expects.

WHAT THIS CONFIGURATION GETS, AND WHAT IT DOES NOT
--------------------------------------------------
`server-library` + `no-tenant-code` enforcement is P1 for free — the tenant
has no code execution in this process, so they cannot modify the code that
measures them. P3 is ordinary secret management: an API key and a sealed
component key, handled the way any other backend secret is.

**The leaf is still `passthrough`.** PLACEMENT_AND_SURFACES.md §5.2's
top-right cell: `server-library` with no attestation yields `passthrough`,
and nothing lifts it to `verified` except an attestation chained to a vendor
root, which no verifier plugin in the estate can produce today. A free P1
buys two properties and zero tiers. The demo prints this on every run
because a vendor who first learns it from an auditor was told by omission.

THE OTHER CONFIGURATION THE SAME VENDOR HAS
-------------------------------------------
If this backend also offers a custom `handler.py`, `trust_remote_code`, or a
customer-supplied container image, then on THAT path tenant code runs in
this process and `no-tenant-code` is false. Declare it honestly and the SDK
resolves it to `unattested-client` and refuses to witness at all
(PLACEMENT_AND_SURFACES.md §7.3). A vendor is not a placement; a
configuration is. `run_demo.py` scenario 3 shows exactly what that looks
like.
"""

from __future__ import annotations

import os
from typing import Any, Optional

# ── THE INTEGRATION ─────────────────────────────────────────────────────────
# Everything a vendor writes is between these two markers.

from scruple_api.surface import PlacementEnforcement
from scruple_host_sdk import Client
from scruple_host_sdk.server_library import ServerLibraryIntegration, provision_component


def attach(
    *,
    base_url: str,
    api_key: str,
    provisioning_token: str,
    build_measurement: str,
    seal_path: str,
    envelope_signers: Any = (),
    enforcement: PlacementEnforcement = PlacementEnforcement.NO_TENANT_CODE,
) -> ServerLibraryIntegration:
    """Once per worker process, at startup."""
    client = Client(
        host="acme-inference",
        integration_version="1.0.0",
        api_key=api_key,
        base_url=base_url,
        cache_dir=os.path.dirname(seal_path),
        queue_path=os.path.join(os.path.dirname(seal_path), "witness-queue.jsonl"),
    )
    client.attach(code_paths=[__file__])
    identity, ratchet = provision_component(
        client,
        token=provisioning_token,
        build_measurement=build_measurement,
        seal_path=seal_path,
    )
    return ServerLibraryIntegration(
        client,
        component=identity,
        ratchet=ratchet,
        enforcement=enforcement,
        envelope_signers=envelope_signers,
        seal_path=seal_path,
    )


def handle_request(integration: ServerLibraryIntegration, output_path: str, mime: str):
    """Once per artifact the handler produces."""
    return integration.witness_file(output_path, mime=mime, kind="artifact")


# ── END OF THE INTEGRATION ──────────────────────────────────────────────────
#
# 38 lines of vendor code, and 30 of them are two constructor calls broken
# across lines. Collapsed, it is: build a Client, attach a baseline,
# provision a component, construct a ServerLibraryIntegration, call
# witness_file() per artifact. Five calls.
#
# There is no retry loop, no queue management, no MAC, no counter, no
# envelope assembly and no tier logic in any of it — all six are things
# CANON_SKELETON.md §5 says an adapter may not do, and the SDK owning them
# is what makes that list enforceable rather than aspirational.
#
# What is NOT here and should not appear here:
#
#   * `try/except` around the witness call. `http.submit()` enqueues on
#     failure inside its own control flow; a vendor catching and retrying
#     would double-send and would re-MAC, which means a second counter for
#     one event.
#   * `mimetypes.guess_type()`. MIME is declared or it is absent; a
#     placeholder is a declaration that is false.
#   * anything computing a posture. `integration.assurance()` reports one;
#     nothing here may assert one.


def drain_on_shutdown(integration: ServerLibraryIntegration) -> dict:
    """Call from the vendor's own scheduler or shutdown hook. There is no
    background thread in the SDK and there will not be one."""
    return integration.drain()
