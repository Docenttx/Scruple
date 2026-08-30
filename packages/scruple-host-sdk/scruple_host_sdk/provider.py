"""Registration -- the SDK half of the API/SDK seam.

This is the only module in this package that `scruple-api` ever hears
from, and it is a one-way call: the SDK registers itself with the API. The
API imports nothing from here, which is what makes
`tests/test_no_network_capability.py`'s "no import of the SDK" rule
checkable rather than aspirational.

Deployment shape:

    # once, at process/host startup, in code the operator owns
    import scruple_host_sdk
    scruple_host_sdk.register(
        host="acme-inference",
        integration_version="4.2.0",
        api_key=os.environ["SCRUPLE_API_KEY"],
    )

Every `scruple_api.get_recorder(...)` handed out before that call --
including at module import time, which for a Blender add-on or a ComfyUI
custom node is the normal case -- starts producing leaves on its next
call. See `scruple_api/provider.py` for why the proxy is what makes that
true.

`Client` needs no adapting: it already has `attach`, `witness`,
`witness_file`, `mark`, `capabilities` and `detach` with the right
signatures, so it satisfies `scruple_api.WitnessRecorder` structurally.
That is deliberate. If the SDK's real object needed a wrapper to fit the
API's interface, the interface would be describing something other than
what we actually ship.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from scruple_api.provider import (
    WitnessRecorder,
    reset_witness_provider,
    set_witness_provider,
)

from .client import Client

__all__ = ["ClientWitnessProvider", "register", "unregister"]


class ClientWitnessProvider:
    """Builds `Client`s. Holds the deployment concerns -- key, base URL,
    timeout, queue and cache locations -- so that instrumentation call
    sites carry none of them and need not change when they change.

    One `Client` per (host, integration_version), cached: a Client owns a
    queue file and a session baseline, and handing out a fresh one per
    call site would give each its own baseline state and its own view of
    the queue.
    """

    def __init__(self, **client_kwargs: Any) -> None:
        self._client_kwargs = client_kwargs
        self._recorders: Dict[tuple, Client] = {}

    def get_recorder(self, *, host: str, integration_version: str, **kwargs: Any) -> WitnessRecorder:
        key = (host, integration_version)
        existing = self._recorders.get(key)
        if existing is not None:
            return existing
        merged = dict(self._client_kwargs)
        merged.pop("host", None)
        merged.pop("integration_version", None)
        merged.update(kwargs)
        client = Client(host=host, integration_version=integration_version, **merged)
        self._recorders[key] = client
        return client


def register(
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: Optional[float] = None,
    queue_path: Optional[str] = None,
    opener: Optional[Any] = None,
    cache_dir: Optional[str] = None,
    provider: Optional[Any] = None,
) -> Any:
    """Install this SDK as the process-wide witness provider.

    Once per process. Re-registering the same provider object is a no-op;
    a different one raises `ProviderAlreadySetError` rather than silently
    losing -- see `scruple_api/provider.py`, which explains why we diverge
    from OTel's warn-and-continue here. Call `unregister()` first if a
    host is deliberately tearing the integration down and standing it back
    up (add-on disable/enable).

    Returns the provider, so a caller that wants to keep a handle for its
    own teardown can.
    """
    p = provider or ClientWitnessProvider(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        queue_path=queue_path,
        opener=opener,
        cache_dir=cache_dir,
    )
    set_witness_provider(p)
    return p


def unregister() -> None:
    """Tear down the registration. Recorders already handed out fall back
    to the validating no-op on their next call, and pick up whatever is
    registered after that."""
    reset_witness_provider()
