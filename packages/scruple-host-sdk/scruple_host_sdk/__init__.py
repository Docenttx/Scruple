"""scruple_host_sdk -- the implementation half of the Scruple client.

One package replacing the six copy-pasted forks (Blender, Meshroom,
ToonBoom, Fusion, Adobe, and the standalone scripts) described in
docs/canon/CANON_SKELETON.md. Pure standard library, Python 3.10+ --
these modules run inside embedded interpreters where pip cannot be
assumed.

THIS PACKAGE NOW HAS ONE DEPENDENCY: `scruple-api`. Said loudly, because
`pyproject.toml`'s `dependencies = []` was a deliberate promise and this
is the first thing to touch it. It is still a `cp -r` install -- both
packages are pure standard library, so vendoring is two directories side
by side instead of one, with no pip and no resolver. Nothing third-party
was added and nothing will be. See `pyproject.toml`.

WHICH PACKAGE TO USE
--------------------
**Instrumenting?** Use `scruple-api` and nothing else:

    import scruple_api
    recorder = scruple_api.get_recorder(host="blender", integration_version="0.1.0")
    recorder.witness_file("/tmp/render.png", mime="image/png", kind="artifact")

Safe at module scope, safe before Scruple is configured, safe in code paths
nobody has security-reviewed -- `scruple-api` cannot open a socket, and an
AST scan plus a runtime test prove it on every run. Those calls are inert
until an SDK is registered and live afterwards, with no re-import.

**Configuring?** That is this package, once, at startup, in code the
operator owns:

    import scruple_host_sdk
    scruple_host_sdk.register(api_key=os.environ["SCRUPLE_API_KEY"])

**Driving the client directly?** `Client` is still here and still works
exactly as it did; `register()` is a thin wrapper over constructing one.

    from scruple_host_sdk import Client

    client = Client(host="blender", integration_version="0.1.0")
    client.attach(code_paths=[__file__])
    outcome = client.witness_file("/tmp/render.png", mime="image/png", kind="artifact")

WHAT LIVES WHERE, AND WHY
-------------------------
Here: `http` (the sole network gateway), `auth`, `queue`, `payment`,
`preferences`, `state`, `ratchet`, `client`, `provider` -- everything that
opens a socket, holds key material, or spools to disk.

In `scruple-api`: `errors`, `outcomes`, `manifest`, `capture`, `modality`,
`surface`, `provider` -- interfaces, types, and the two canon properties
that are decidable without a network call.

`errors`, `manifest`, `capture` and `surface` remain importable from this
package as re-export shims, so `scruple_host_sdk.capture.capture(...)` and
`scruple_host_sdk.surface.CaptureSurface` keep working. They are shims,
not copies: the classes are the same objects, so `except ScrupleError:`
matches across both packages.

`capture()` (hashing a file without a Client -- rare, but occasionally
useful for a caller that only wants the content_hash) is available as
`scruple_host_sdk.capture.capture(...)`. It is deliberately not
re-exported at this top level: this module's own name for its capture
submodule is `capture`, and shadowing that name with the function it
contains is exactly the kind of accidental-rebinding bug this package
exists to not have.
"""

from scruple_api.modality import Capability
from scruple_api.outcomes import AttachResult, MarkOutcome, Outstanding, WitnessOutcome
from scruple_api.provider import ProviderAlreadySetError

from .client import Client
from .errors import (
    BaselineConflictError,
    MimeRequiredError,
    ModalityUnavailableError,
    NoBaselineError,
    ScrupleAPIError,
    ScrupleError,
    ScrupleTransportError,
)
from .payment import PaymentResult
from .provider import ClientWitnessProvider, register, unregister

__version__ = "0.1.0"

__all__ = [
    # registration -- the API/SDK seam
    "register",
    "unregister",
    "ClientWitnessProvider",
    # the client itself
    "Client",
    "AttachResult",
    "Capability",
    "WitnessOutcome",
    "MarkOutcome",
    "Outstanding",
    "PaymentResult",
    # errors (the same class objects scruple_api raises)
    "ScrupleError",
    "ScrupleTransportError",
    "ScrupleAPIError",
    "BaselineConflictError",
    "NoBaselineError",
    "MimeRequiredError",
    "ModalityUnavailableError",
    "ProviderAlreadySetError",
]
