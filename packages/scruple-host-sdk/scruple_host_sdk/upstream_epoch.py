"""Upstream restart detection — the vocabulary, in Python.

WO-C5. The measurement itself lives in ``lib/capture/upstreamEpoch.ts``, and
this module deliberately does NOT reimplement it. ``storage_confinement.py``
carries a full second implementation because the ``server-library`` placement
can genuinely measure its own device pair where ``seal_path`` makes it
knowable — there is a fact to compute. Here there is not:

    THE SIDECAR GATE SITS BETWEEN A TENANT AND A SEPARATE COMFYUI PROCESS
    WHOSE IN-MEMORY ``/history`` RING CAN BE SILENTLY RESET UNDER IT. AT
    ``server-library`` THE VENDOR'S HANDLER *IS* THE OBSERVATION — in-process,
    with no ``/system_stats`` to poll and no history ring to lose.

So this placement has no upstream to ask, and the honest leaf says so. What it
needs from this file is the VOCABULARY, so that the value it emits is the same
string the TypeScript validator recognises and the same string migration 057's
CHECK admits — a second spelling of ``not_queried`` would be refused at ingest
and would look like a component fault.

⚑ WHY ``not_queried`` IS NOT A SHRUG. Architect, hand round 5:

    "'not enumerated' is right, but the reason field needs to distinguish
    restart/eviction (bounded, detectable if you record the history epoch
    identity and the low watermark at both query ends) from 'history simply
    not queried' — otherwise the volatile source degrades to unknown for both
    the recoverable and unrecoverable cases and you lose the only signal that
    would tell an operator to shorten their query interval."

A placement that has nothing to ask and a placement whose query failed are
different operational conditions with different fixes. Folding them is the
thing the council refused.

If a future host-library placement DOES acquire a separate upstream with a
volatile enumeration — a vendor whose handler proxies to a worker process, say
— this file is where the real measurement goes, and it should be a
transcription of the TypeScript rules rather than a second invention of them.
``test/vectors/component-preimage-vectors.json`` is what would hold the two
together, exactly as it does for the ratchet key schedule.
"""

from __future__ import annotations

from typing import Any, Dict

#: ``upstream_continuity``. Three values; ``UNKNOWN`` is a first-class answer
#: and is not a soft ``CONTINUOUS`` — an idle upstream and a restarted idle
#: upstream are the same reading, and saying ``continuous`` there is exactly
#: "letting a restart look like a quiet afternoon".
CONTINUOUS = "continuous"
RESTARTED = "restarted"
UNKNOWN = "unknown"
CONTINUITIES = (CONTINUOUS, RESTARTED, UNKNOWN)

#: ``upstream_uncaptured_reason``. Why an absence set drawn from ``/history``
#: is or is not a closure. Five operational conditions, five different fixes.
ENUMERATED = "enumerated"
EVICTED_OR_RESTARTED = "evicted_or_restarted"
INTERVAL_NOT_COVERED = "interval_not_covered"
HISTORY_UNAVAILABLE = "history_unavailable"
NOT_QUERIED = "not_queried"
REASONS = (
    ENUMERATED,
    EVICTED_OR_RESTARTED,
    INTERVAL_NOT_COVERED,
    HISTORY_UNAVAILABLE,
    NOT_QUERIED,
)

#: ``upstream_source``. The invariant every asserted field in this design
#: carries. There is no third.
SOURCE_MEASURED = "measured"
SOURCE_UNKNOWN = "unknown"
SOURCES = (SOURCE_MEASURED, SOURCE_UNKNOWN)

#: The seven capture keys a leaf from a placement with no upstream carries.
#: Named once, here, so it cannot drift into a default written at three call
#: sites — which is how ``pinned_build`` became config-inherited.
UNQUERIED: Dict[str, Any] = {
    "upstream_identity": None,
    "upstream_epoch": None,
    "upstream_continuity": UNKNOWN,
    "upstream_low_watermark_open": None,
    "upstream_low_watermark_close": None,
    "upstream_uncaptured_reason": NOT_QUERIED,
    "upstream_source": SOURCE_UNKNOWN,
}
