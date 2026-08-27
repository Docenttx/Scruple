"""scruple_host_sdk -- the canon client SDK for Scruple host integrations.

One package replacing the six copy-pasted forks (Blender, Meshroom,
ToonBoom, Fusion, Adobe, and the standalone scripts) described in
docs/canon/CANON_SKELETON.md. Pure standard library, Python 3.10+ --
these modules run inside embedded interpreters where pip cannot be
assumed.

Import `Client` and nothing else, in the ordinary case:

    from scruple_host_sdk import Client

    client = Client(host="blender", integration_version="0.1.0")
    client.attach(code_paths=[__file__])
    outcome = client.witness_file("/tmp/render.png", mime="image/png", kind="artifact")

`capture()` (hashing a file without a Client -- rare, but occasionally
useful for a caller that only wants the content_hash) is available as
`scruple_host_sdk.capture.capture(...)`. It is deliberately not
re-exported at this top level: this module's own name for its capture
submodule is `capture`, and shadowing that name with the function it
contains is exactly the kind of accidental-rebinding bug this package
exists to not have.
"""

from .capabilities import Capability
from .client import AttachResult, Client
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
from .witness_flow import MarkOutcome, Outstanding, WitnessOutcome

__version__ = "0.1.0"

__all__ = [
    "Client",
    "AttachResult",
    "Capability",
    "WitnessOutcome",
    "MarkOutcome",
    "Outstanding",
    "PaymentResult",
    "ScrupleError",
    "ScrupleTransportError",
    "ScrupleAPIError",
    "BaselineConflictError",
    "NoBaselineError",
    "MimeRequiredError",
    "ModalityUnavailableError",
]
