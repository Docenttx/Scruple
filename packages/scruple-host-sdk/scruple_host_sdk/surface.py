"""Re-export of the capture-surface contract, which lives in `scruple-api`.

`surface.py` is an interface -- Protocols, enums, the placement/assurance
lattice and a build-time registry -- and it is the interface a vendor
implements for a host we have not met. It belongs with the types, not with
the implementation: writing a capture surface must not require installing
anything that can open a socket. Its `ObservationSink` Protocol is the
API/SDK seam itself -- a surface observes bytes and hands observations to
a sink, and the sink is always the SDK's.

Contrast `ratchet.py`, which stayed on this side despite being equally
network-free: it derives and holds key material, and this module's own
rule says a surface must not compute a MAC or advance the ratchet counter.

`docs/canon/PLACEMENT_AND_SURFACES.md` and the TypeScript mirror
`lib/capture/surface.ts` are unchanged; `scruple_host_sdk.surface` keeps
working as an import path.

See `scruple_api/surface.py`.
"""

from __future__ import annotations

from scruple_api.surface import *  # noqa: F401,F403
from scruple_api.surface import __all__ as __all__
from scruple_api.surface import _reset_surface_registry_for_tests  # noqa: F401
