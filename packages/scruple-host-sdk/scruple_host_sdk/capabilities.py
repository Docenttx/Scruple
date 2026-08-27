"""Client side of GET /v2/capabilities (D-7) and property 2: an unknown
or unavailable modality fails closed, never downgrades to something
cheaper that looks similar.

Not one of the nine names CANON_SKELETON.md §5 lists (auth, capture,
manifest, queue, state, witness_flow, payment, preferences, client) --
it is new infrastructure this SDK needed to make property 2 true rather
than merely documented, split out of witness_flow.py/client.py because
both mark() and an adapter's own "should I show this button" check need
the same fail-closed logic and neither should reimplement it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from . import http as _http
from .errors import ModalityUnavailableError

KNOWN_MODALITIES = {"c2pa", "watermark", "chain", "local"}


@dataclass(frozen=True)
class Capability:
    modality: str
    available: bool
    reason: str
    price_cents: Optional[int] = None


def fetch(session, *, host: str, mime: str) -> List[Capability]:
    """GET /v2/capabilities. Not queued on failure (queue_kind=None) --
    this is a query, not a Phase-3 operation; see http.submit()'s
    docstring for why only witness/mark/baseline calls are enqueued."""
    result = _http.submit(session, "GET", "/api/v2/capabilities", query={"host": host, "mime": mime})
    caps: List[Capability] = []
    if result.ok and isinstance(result.body, dict):
        for row in result.body.get("modalities", []):
            caps.append(
                Capability(
                    modality=row.get("modality", ""),
                    available=bool(row.get("available")),
                    reason=row.get("reason", ""),
                    price_cents=row.get("price_cents"),
                )
            )
        session.state.capabilities_cache[(host, mime)] = caps
    return caps


def check(session, *, host: str, mime: str, modality: str) -> Capability:
    """Property 2, made concrete. Every return path either reflects a
    server-confirmed fact or refuses -- none returns available=True on
    the strength of an assumption:

      - `modality` not in KNOWN_MODALITIES -> refuse, no network call.
      - cached (or freshly fetched) capabilities say unavailable ->
        refuse with the server's own stated reason.
      - capabilities could not be determined at all (never cached, and
        this call's own fetch() failed or returned nothing) -> refuse.
      - the server's list simply does not mention this modality -> refuse.
    """
    if modality not in KNOWN_MODALITIES:
        return Capability(
            modality=modality,
            available=False,
            reason=f'Unknown modality "{modality}". Refusing rather than guessing what it might map to.',
        )

    cached = session.state.capabilities_cache.get((host, mime))
    if cached is None:
        cached = fetch(session, host=host, mime=mime)

    if not cached:
        return Capability(
            modality=modality,
            available=False,
            reason="Could not reach GET /capabilities to confirm applicability. Refusing rather than assuming available.",
        )

    for cap in cached:
        if cap.modality == modality:
            return cap
    return Capability(modality=modality, available=False, reason=f'Server did not report on modality "{modality}".')


def require_available(session, *, host: str, mime: str, modality: str) -> Capability:
    cap = check(session, host=host, mime=mime, modality=modality)
    if not cap.available:
        raise ModalityUnavailableError(cap.reason)
    return cap
