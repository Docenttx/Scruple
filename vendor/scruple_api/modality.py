"""Property 2's enforceable half: an unknown modality fails closed.

CANON_SKELETON.md §5 property 2 is one sentence with two halves, and they
do not belong on the same side of the API/SDK line:

  a. **A modality this build cannot perform is refused.** Pure vocabulary.
     Decidable from the name alone, with no network call, no server, no
     tenant key. It lives here, in `scruple-api`.

  b. **A modality the server reports unavailable for this host/mime is
     refused.** Requires `GET /v2/capabilities`. It lives in the SDK
     (`scruple_host_sdk.capabilities`), because it cannot be answered
     without a network call, and `scruple-api` has none.

Splitting it this way is what keeps the property true for an API-only
consumer. `require_known()` below is the single implementation of half
(a) and it has two call sites on opposite sides of the line:
`scruple_host_sdk.capabilities.check()` (real path) and
`provider.NoOpWitnessRecorder.mark()` (no SDK registered). Neither
reimplements it.

What an API-only consumer therefore gets, and it is the correct answer in
both cases:

  * `mark(modalities=["holotape"])` -> ModalityUnavailableError. Refused
    on the vocabulary, exactly as it would be with the SDK installed.
  * `mark(modalities=["c2pa"])` -> a MarkOutcome with
    `modalities_applied=[]` and `c2pa` listed in `outstanding`. Known
    vocabulary, nothing performed, and said so. Never `witnessed=True`,
    never a silent downgrade to `local`.

The one thing this module must never grow is a local fallback that
answers half (b) optimistically. `available=True` is a server-confirmed
fact or it is not stated.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .errors import ModalityUnavailableError

#: The closed vocabulary. Matching the Signer's `assertion_partition`
#: posture: refuse rather than guess. Adding a value here is a wire-format
#: change -- the server must already understand it.
KNOWN_MODALITIES = frozenset({"c2pa", "watermark", "chain", "local"})


@dataclass(frozen=True)
class Capability:
    """What GET /v2/capabilities said about one modality, or a local
    refusal shaped identically so a caller has one type to handle.

    `available=True` is only ever set from a server response. Nothing in
    `scruple-api` can construct one, because nothing here can ask.
    """

    modality: str
    available: bool
    reason: str
    price_cents: Optional[int] = None


def refuse_unknown(modality: str) -> Optional[Capability]:
    """Return a refusal Capability for an out-of-vocabulary modality, or
    None if the name is known (and therefore still has to be checked
    against the server before anything is claimed about it)."""
    if modality in KNOWN_MODALITIES:
        return None
    return Capability(
        modality=modality,
        available=False,
        reason=f'Unknown modality "{modality}". Refusing rather than guessing what it might map to.',
    )


def require_known(modality: str) -> None:
    """Raise ModalityUnavailableError if `modality` is not in the closed
    vocabulary. Makes no network call and cannot -- see the module
    docstring."""
    refusal = refuse_unknown(modality)
    if refusal is not None:
        raise ModalityUnavailableError(refusal.reason)
