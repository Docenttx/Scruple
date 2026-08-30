"""scruple_api -- the instrumentation surface. No network capability.

`scruple-api` is what a vendor writes their call sites against; the
implementation that talks to scruple.ai lives in `scruple-host-sdk` and is
installed, or not, as a deployment decision. The split follows
OpenTelemetry's api/sdk split (`docs/canon/oss-study/opentelemetry.md`
§1), with one difference that is the whole reason it is worth doing here:
OTel keeps its API free of *implementation* dependencies to avoid version
lock. We keep this package free of *network capability* so that
instrumenting every code path in a vendor's stack is not a decision anyone
has to security-review.

    import scruple_api
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    recorder.witness_file("/out/render.png", mime="image/png", kind="artifact")

With no SDK registered those calls are inert and honest. When
`scruple_host_sdk.register(...)` runs -- later, elsewhere, maybe never --
the same `recorder` object starts producing leaves on its next call. See
`provider.py`.

WHAT IS IN HERE, AND WHAT IS NOT
--------------------------------
In:  errors, outcomes, manifest hashing, capture (hashing + the MIME
     gate), the modality vocabulary, the capture-surface interfaces, the
     provider registry and the no-op.
Out: http, auth, queue, payment, preferences, state, ratchet, client.
     Everything that opens a socket, holds key material, or spools to
     disk.

`ratchet.py` stayed in the SDK even though it is pure `hashlib`/`hmac` and
imports nothing network-shaped. Zero-network is necessary for membership
here, not sufficient: the ratchet derives and holds key material from a
BDK, and `surface.py`'s own rule says a surface "MUST NOT compute a MAC,
advance the ratchet counter, or decide whether a leaf is verified or
passthrough". A package whose stated property is "safe to vendor into any
code path, nothing here can leak anything" cannot also be the package
holding the per-event key chain.

`surface.py` came here, because it is the interface a vendor implements
and its `ObservationSink` is precisely the API/SDK seam: a surface
observes, and hands observations to a sink the SDK provides. A vendor
writing a capture surface for a host we have not met needs the types and
must not need the network.

THE THREE CANON PROPERTIES (CANON_SKELETON.md §5), AND WHERE EACH LANDED
------------------------------------------------------------------------
The rule applied: a property enforced only in the SDK is unenforced for an
API-only consumer, so anything decidable without a network call is
enforced HERE, once, with the SDK calling the same function.

1. **MIME is declared, never guessed.** -> API, wholly.
   `capture.require_mime()` is the single implementation. Two call sites:
   `capture.capture()` (real path) and
   `provider.NoOpWitnessRecorder.witness_file()` (no SDK). A vendor
   wiring up call sites during development gets the refusal immediately,
   which is the only time it is cheap to fix. No `mimetypes` import
   exists in either package.

2. **An unknown modality fails closed.** -> SPLIT, along the line of what
   a network answers. The vocabulary check is here
   (`modality.require_known()`, one implementation, called by both
   `scruple_host_sdk.capabilities.check()` and the no-op's `mark()`); the
   server-availability check stays in the SDK because it *is* a request.
   The no-op's `mark()` therefore refuses an unknown modality outright and
   reports every known one as `outstanding` with `modalities_applied=[]`.
   No path through this package returns `available=True` or
   `witnessed=True`.

3. **The queue is in the failure path by construction.** -> SDK, and it
   must not move.
   The property is "there is exactly one function capable of a failing
   network call, and enqueuing is inline in its control flow"
   (`http.submit`). Its enforcement is `http.py`'s uniqueness, and the
   AST scan proving this package has no network capability is the same
   proof that the property is *vacuously* satisfied here: no call can
   fail on the wire, so there is nothing to spool.
   Putting a queue in `scruple-api` would actively weaken the property.
   An API-only consumer would accumulate a durable on-disk spool of
   witness events with nothing in the process able to drain it -- a file
   that looks like durability and is a leak. So the no-op returns
   `queued=False`, which is true, and `detach()` returns zeros. The
   distinction a caller needs -- "went nowhere, will be retried" vs
   "went nowhere, will not be" -- stays legible, and it is the second
   one.
"""

from __future__ import annotations

from .capture import capture, require_mime, sha256_file
from .errors import (
    BaselineConflictError,
    MimeRequiredError,
    ModalityUnavailableError,
    NoBaselineError,
    ScrupleAPIError,
    ScrupleError,
    ScrupleTransportError,
)
from .manifest import (
    build_machine_manifest,
    canonicalize,
    compute_tamper_surface_hash,
    machine_manifest_hash,
    sha256_hex,
)
from .modality import KNOWN_MODALITIES, Capability, refuse_unknown, require_known
from .outcomes import AttachResult, MarkOutcome, Outstanding, WitnessOutcome
from .provider import (
    NO_SDK_REASON,
    NoOpWitnessProvider,
    NoOpWitnessRecorder,
    Once,
    ProviderAlreadySetError,
    ProxyWitnessProvider,
    ProxyWitnessRecorder,
    WitnessProvider,
    WitnessRecorder,
    get_recorder,
    get_witness_provider,
    is_configured,
    reset_witness_provider,
    set_witness_provider,
)

__version__ = "0.1.0"

__all__ = [
    # the one call instrumentation makes
    "get_recorder",
    "is_configured",
    # registration -- the SDK's entry point, not instrumentation's
    "set_witness_provider",
    "get_witness_provider",
    "reset_witness_provider",
    "WitnessProvider",
    "WitnessRecorder",
    "NoOpWitnessProvider",
    "NoOpWitnessRecorder",
    "ProxyWitnessProvider",
    "ProxyWitnessRecorder",
    "Once",
    "NO_SDK_REASON",
    # outcomes
    "AttachResult",
    "WitnessOutcome",
    "MarkOutcome",
    "Outstanding",
    # capture + hashing
    "capture",
    "require_mime",
    "sha256_file",
    "sha256_hex",
    "canonicalize",
    "build_machine_manifest",
    "machine_manifest_hash",
    "compute_tamper_surface_hash",
    # modality vocabulary
    "Capability",
    "KNOWN_MODALITIES",
    "refuse_unknown",
    "require_known",
    # errors
    "ScrupleError",
    "ScrupleTransportError",
    "ScrupleAPIError",
    "BaselineConflictError",
    "NoBaselineError",
    "MimeRequiredError",
    "ModalityUnavailableError",
    "ProviderAlreadySetError",
]
