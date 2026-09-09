"""Storage confinement — measured, per leaf, off raw ``os.stat``.

WO-C4, and the Python half of ``lib/capture/storageConfinement.ts``. The
finding is IT Expert's and the council confirmed it in the code: the directory
holding the ratchet's sealed state and durable queue has NO stated constraint
against sharing a filesystem with the volume the workload writes into. So::

    an uncaptured runaway write exhausts blocks on a shared filesystem
      -> the ratchet's local append cannot fsync()
      -> and the MAC is the BLOCKING half of emit()
      -> fail-closed becomes FAIL-STOPPED, triggered by the very artifact
         class the gate cannot see.

Two halves were settled. The STARTUP REFUSAL is bound to the moment a capture
proxy binds its socket, and no placement in this package binds one — these are
in-process integrations, not gates. The PER-LEAF RE-READ applies everywhere a
leaf is emitted, and that is what this module is for.

⚑ RAW ``os.stat`` ON EVERY CALL. Architect: "a startup-only check is a
config-inherited fact by the time the leaf is emitted — volumes can be
remounted or bind-mounted after boot, which is exactly the inheritance pattern
we killed on ``pinned_build``." IT Expert added the mechanism: raw device
identifiers rather than cached path lookups, "the difference between the check
working and looking like it works". Nothing here is memoised, and nothing here
should ever be given an lru_cache.

The value set and the decision order are the TypeScript module's, field for
field, because a second answer to "is this component's state confined" is a
second answer.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Sequence

#: 64 MiB. A floor beneath which the queue, the sealed state and the journal
#: needed to commit them are not comfortably placeable. A policy, not a fact.
DEFAULT_MIN_RESERVABLE_BYTES = 64 * 1024 * 1024

CONFINED = "confined"
DEGRADED_SHARED_STORAGE = "degraded_shared_storage"
DEGRADED_NO_RESERVATION = "degraded_no_reservation"
UNKNOWN = "unknown"

MEASURED = "measured"


@dataclass(frozen=True)
class StorageMeasurement:
    """What one emission measured. ``source`` is ``measured`` or ``unknown``
    and there is no third value: configuration, inheritance, prior
    certification and defaults cannot populate a fact."""

    confinement: str
    source: str
    reason: str


#: The honest answer for a placement with nothing to compare — no declared
#: watched volume, so no sharing question. NOT ``confined``: a component that
#: measured nothing has not established a boundary.
UNMEASURED = StorageMeasurement(
    confinement=UNKNOWN,
    source=UNKNOWN,
    reason="this placement declares no watched volume, so there is no device pair to compare",
)


def _dev(path: str) -> Optional[int]:
    try:
        return os.stat(path).st_dev
    except OSError:
        return None


def measure(
    state_dir: str,
    volumes: Sequence[str],
    min_reservable_bytes: int = DEFAULT_MIN_RESERVABLE_BYTES,
) -> StorageMeasurement:
    """Measure now. Call it per emission, never once at construction."""
    if not volumes:
        return UNMEASURED

    state_dev = _dev(state_dir)
    vol_devs = [(v, _dev(v)) for v in volumes]

    unreadable = [state_dir] if state_dev is None else []
    unreadable += [v for v, d in vol_devs if d is None]
    if unreadable:
        return StorageMeasurement(
            confinement=UNKNOWN,
            source=UNKNOWN,
            reason="a device identity could not be read: " + ", ".join(unreadable),
        )

    shared = [v for v, d in vol_devs if d == state_dev]
    if shared:
        return StorageMeasurement(
            confinement=DEGRADED_SHARED_STORAGE,
            source=MEASURED,
            reason=(
                f"st_dev {state_dev} is shared by the ratchet state ({state_dir}) and "
                + ", ".join(shared)
                + ". A write into a watched volume can exhaust the blocks the ratchet "
                "needs to fsync its counter."
            ),
        )

    try:
        vfs = os.statvfs(state_dir)
        # f_bavail, not f_bfree: the root-reserved blocks are not writable by a
        # service user, and counting them is how "there is room" passes on a
        # filesystem with no room.
        available = vfs.f_bavail * vfs.f_frsize
    except OSError as exc:  # pragma: no cover - statvfs failing is rare
        return StorageMeasurement(
            confinement=UNKNOWN,
            source=UNKNOWN,
            reason=f"statvfs({state_dir}) failed ({exc}); reservable capacity unmeasured",
        )

    if available < min_reservable_bytes:
        return StorageMeasurement(
            confinement=DEGRADED_NO_RESERVATION,
            source=MEASURED,
            reason=(
                f"{state_dir} is on its own device (st_dev {state_dev}) but has {available} "
                f"bytes available, below the {min_reservable_bytes}-byte floor. A separate "
                "filesystem with no room stops fsync exactly as a shared one does."
            ),
        )

    return StorageMeasurement(
        confinement=CONFINED,
        source=MEASURED,
        reason=(
            f"ratchet state on st_dev {state_dev}, watched volumes elsewhere, "
            f"{available} bytes available (floor {min_reservable_bytes})"
        ),
    )
