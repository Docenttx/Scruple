"""``claim`` — assemble the record, and ask what it supports.

WO-G5. The add-on-facing front door to `source_type.derive()`. It gathers the
three things a claim rests on and hands them over:

    what entered the document   `scene.imported_datablocks()`   (WO-F3)
    what is installed in the host `host_addons.enumerate_addons()` (§4)
    what was installed at the baseline   the cached set, if there is one

⚑ NOTHING HERE DECIDES ANYTHING. The derivation lives in one module and this
one only feeds it — because a second place that could reach a conclusion is a
second place that could reach a different one.

⚑ AND THE BASELINE IS A FILE, NOT A MEMORY. A per-session baseline would reset
every time Blender restarted, and "the plugin set did not change" would become
"the plugin set did not change since you opened Blender ninety seconds ago" —
a claim so weak that making it would be worse than not making it.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from adapter import host_addons as _addons
from adapter import scene as _scene
from adapter import source_type as _source_type

#: Where the add-on set at baseline time is kept. Beside the add-on's other
#: state, and overridable so a test rig does not write into a user's profile.
BASELINE_ENV = "SCRUPLE_ADDON_BASELINE_PATH"


def baseline_path() -> str:
    override = os.environ.get(BASELINE_ENV)
    if override:
        return override
    try:
        import bpy  # type: ignore
        base = bpy.utils.user_resource("CONFIG", path="scruple", create=True)
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".scruple")
        os.makedirs(base, exist_ok=True)
    return os.path.join(base, "addon-baseline.json")


def read_baseline() -> Optional[Dict[str, Any]]:
    """The add-on set as it was when the baseline was taken, or None.

    A missing file is None and NOT an empty set, for the reason this estate
    repeats everywhere: "nobody has taken a baseline" and "the baseline was
    empty" are different facts and only one of them can carry a claim.
    """
    p = baseline_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("addons") is not None else None


def write_baseline(doc: Optional[Dict[str, Any]]) -> Optional[str]:
    """Record the current set as the baseline. Returns the path, or None."""
    if not doc:
        return None
    p = baseline_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, sort_keys=True)
    # Atomic, so a baseline is never half-written. A truncated baseline would
    # read as "not comparable" and quietly stop every claim.
    os.replace(tmp, p)
    return p


def current(*, edits_existing_work: bool = False,
            ai_origin_digests=()) -> Dict[str, Any]:
    """What claim this document supports right now, with its evidence.

    Returns the derived claim plus the two documents it was derived from, so a
    panel can say WHY rather than only WHAT — "refused" with no reason is a
    dialog a user closes and ignores.
    """
    imported = _scene.imported_datablocks()
    addons = _addons.enumerate_addons()
    baseline = read_baseline()
    change = _addons.changed(baseline, addons) if baseline else None

    claim = _source_type.derive(
        imported=imported,
        addons=addons,
        addon_change=change,
        ai_origin_digests=ai_origin_digests,
        edits_existing_work=edits_existing_work,
    )
    return {
        "claim": dict(claim),
        "addon_change": change,
        "has_baseline": baseline is not None,
        "wire": {
            **_addons.wire_fields(addons),
            # ⚑ THE DERIVED TYPE IS NOT ON THE WIRE YET, and saying so here is
            # the point. `client.mark()` takes leaf_id, mime, modalities,
            # chain_tier and payment_intent_id — there is no field for a
            # digitalSourceType, so the server cannot be told what this scene
            # supports. Carrying it is a wire-format change on both sides;
            # docs/G5-NO-AI-CLAIM.md names it as the work that is left.
            "digital_source_type": claim.get("digital_source_type"),
            "claim_refused": None if claim.get("ok") else claim.get("code"),
        },
    }
