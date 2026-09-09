"""``declared_uncaptured`` — the absence set's vocabulary, in Python.

WO-E2. The settled scope rule is ``docs/canon/DECLARED_UNCAPTURED.md`` and the
enumeration itself lives in ``lib/capture/declaredUncaptured.ts``. This module
deliberately does NOT reimplement it, for exactly the reason ``upstream_epoch``
next door does not reimplement the bracket:

    THE ABSENCE SET IS A DIFF BETWEEN AN UPSTREAM'S ``/history`` AND WHAT A
    GATE CAPTURED. AT ``server-library`` THERE IS NO UPSTREAM AND NO GATE —
    the vendor's handler *is* the observation, in-process, so there is no
    ``/history`` to enumerate and no captured set to diff against.

So this placement enumerates nothing, and the honest leaf says so. What it
needs from this file is the VOCABULARY, so the value it emits is the string the
TypeScript validator recognises and the one migration 059's CHECK admits.

⚑ ``not_enumerated`` IS NOT AN EMPTY SET, AND THAT IS THE WHOLE POINT.
Round 5 §3 put the question as whether the set "carries the scope it enumerated
over ... or asserts a closure it does not have". A count of ``0`` says the
component looked and found nothing uncaptured; ``None`` says it did not look.
Those are different operational conditions with different owners, and rule 8
refuses each in the other's clothes. This placement is the second one: it has
nothing to enumerate, so the count is ``None``.

⚑ AND WHY THE COMPLETENESS SOURCE IS ``unknown`` EVERYWHERE TODAY. Coder,
round 5 fact (b):

    "completeness is source: unknown unless an independent observer establishes
    the relevant history window and continuity."

The only party reading ``/history`` is the component that emits the leaf, which
is not independent of its own claim. The TypeScript side derives this from a
NAMED BLOCKER (``UNCAPTURED_INDEPENDENT_OBSERVER``) rather than hardcoding it,
so the day an independent observer exists the value moves without a schema
change; here there is nothing to derive, because there is no enumeration to be
independent of.

If a future host-library placement DOES acquire a separate upstream with a
volatile enumeration, this file is where the real diff goes, and it should be a
transcription of the TypeScript rules rather than a second invention of them.
"""

from __future__ import annotations

from typing import Any, Dict

#: ``uncaptured_enumeration_method``. How the set was obtained. ``NONE`` is not
#: "an empty enumeration": it is the absence of one.
LIVE_HISTORY = "live_history"
METHOD_NONE = "none"
METHODS = (LIVE_HISTORY, METHOD_NONE)

#: ``uncaptured_scope``. The completeness RESULT line 369 asks for by name.
#:
#:   ``complete``        every condition a closure claim needs holds
#:   ``partial``         the enumeration is real and is NOT a closure; absence
#:                       from the set means nothing, and the document names
#:                       every condition that failed
#:   ``not_enumerated``  no enumeration exists — no set, no count, no digest
COMPLETE = "complete"
PARTIAL = "partial"
NOT_ENUMERATED = "not_enumerated"
SCOPES = (COMPLETE, PARTIAL, NOT_ENUMERATED)

#: ``uncaptured_scope_source``. The measured-or-unknown invariant, applied to
#: the COMPLETENESS rather than to the enumeration. There is no third.
SOURCE_MEASURED = "measured"
SOURCE_UNKNOWN = "unknown"
SOURCES = (SOURCE_MEASURED, SOURCE_UNKNOWN)

#: The five capture keys a leaf from a placement with nothing to enumerate
#: carries. Named once, here, so it cannot drift into a default written at
#: three call sites — which is how ``pinned_build`` became config-inherited.
UNENUMERATED: Dict[str, Any] = {
    "uncaptured_enumeration_method": METHOD_NONE,
    "uncaptured_scope": NOT_ENUMERATED,
    "uncaptured_scope_source": SOURCE_UNKNOWN,
    "declared_uncaptured_count": None,
    "declared_uncaptured_hash": None,
}
