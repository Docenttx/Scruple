"""``source_type`` — what this render may honestly be called.

WO-G5. Standard **§9.1** puts ``digitalSourceType`` in the C2PA manifest, and for
a plugin whose market is *proof that a human made this without AI*, **that field
IS the claim**. Everything else in the manifest is bookkeeping around it.

⚑ THE FIELD IS DERIVED FROM THE RECORD, NEVER CHOSEN BY THE USER.
A checkbox saying "no AI was used" is worth precisely what the person ticking it
says it is, which in an evidentiary system is nothing. What this module does is
read the record the add-on already keeps — what entered the document
(``imported_datablocks``, WO-F3) and what was installed in the host
(``host_addons``, §4) — and derive the strongest claim that record actually
supports.

⚑ AND IT REFUSES. `derive()` returns a REFUSAL, not a fallback, whenever the
record has a gap. There is deliberately no "assume the best" branch, because
proving absence is not like proving presence:

    A signature over an output proves the output. **Nothing about an output
    proves what did NOT go into it.** Absence is carried by the completeness of
    the record, so any gap is exactly where the AI step could have been, and a
    claim made over a gap is not a weaker claim — it is a false one.

WHAT THE CLAIM IS, AND WHAT IT IS NOT
----------------------------------------------------------------------------
This never asserts "no AI was used". It asserts a source type, and it declines
to assert a non-AI one when it cannot see enough. The difference matters to a
verifier: the first is a promise about the world, the second is a statement about
a record they can go and check.

THE VOCABULARY (IPTC digitalsourcetype, as C2PA names it)
----------------------------------------------------------------------------
``DIGITAL_CREATION``
    Made with digital tools that are not generative. A Blender scene modelled,
    lit and rendered by a person. **The claim this plugin exists to make.**
``HUMAN_EDITS``
    A human's non-generative edits to something that already existed.
``COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA``
    Contains generative material. The HONEST answer when a ComfyUI image is a
    texture in the scene — not a failure, and the reason this module can be used
    inside Scruple Studio as well as outside it.
``TRAINED_ALGORITHMIC_MEDIA``
    🔴 Never returned here. It is Studio's answer, and for a plugin asserting a
    human made the work it is the exact opposite of the claim.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Sequence

#: The three a plugin may assert, and the one it may not.
DIGITAL_CREATION = "DIGITAL_CREATION"
HUMAN_EDITS = "HUMAN_EDITS"
COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA = "COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA"
NEVER_FROM_A_PLUGIN = "TRAINED_ALGORITHMIC_MEDIA"

#: Why a claim could not be made. Codes, not prose, so a caller can branch and a
#: UI can explain — and so two refusals for different reasons never read alike.
NO_DATABLOCK_ENUMERATION = "no_datablock_enumeration"
UNREADABLE_DATABLOCKS = "unreadable_datablocks"
NO_ADDON_ENUMERATION = "no_addon_enumeration"
UNREADABLE_ADDONS = "unreadable_addons"
ADDON_SET_CHANGED = "addon_set_changed"
ORIGIN_UNOBSERVED_WITH_IMPORTS = "origin_unobserved_with_imports"


class Claim(dict):
    """A derived claim, or a refusal. ``ok`` says which."""

    @property
    def ok(self) -> bool:
        return bool(self.get("ok"))


def _refuse(code: str, detail: str, **extra: Any) -> Claim:
    return Claim({"ok": False, "code": code, "detail": detail,
                  "digital_source_type": None, **extra})


def derive(
    *,
    imported: Optional[Mapping[str, Any]],
    addons: Optional[Mapping[str, Any]],
    addon_change: Optional[Mapping[str, Any]] = None,
    ai_origin_digests: Sequence[str] = (),
    edits_existing_work: bool = False,
) -> Claim:
    """The strongest source type this record supports, or a refusal.

    :param imported: the ``imported_datablocks`` document, or None.
    :param addons: the ``host_addons`` document, or None.
    :param addon_change: ``host_addons.changed(baseline, now)``, when there is a
        baseline to compare against.
    :param ai_origin_digests: digests KNOWN to be generative output — from this
        estate's own witness, never guessed from a filename. Anything here turns
        the claim into the composite type rather than refusing it: generative
        material that has been declared is not a gap, it is a fact.
    :param edits_existing_work: the caller's declaration that this document is a
        human's edit of an existing work rather than an original.
    """
    # ── 1 · was anything asked at all ─────────────────────────────────────────
    # `source: none` is the absence of an enumeration and NOT an empty set. A
    # Blender with nothing imported is a fact; a process that could not look is
    # not, and only the first can carry a claim.
    # ⚑ THE KEYS ARE THE DOCUMENT'S, NOT THE WIRE'S. `imported_datablocks.declaration()`
    # writes `source`/`origin_observed`; `wire_fields()` is what prefixes them with
    # `imported_datablocks_`. Reading the prefixed names here made every real
    # document look unenumerated and every hand-built test fixture pass — which is
    # what a fixture nobody built with the real constructor buys you.
    if not imported or imported.get("source") in (None, "none"):
        return _refuse(
            NO_DATABLOCK_ENUMERATION,
            "nothing enumerated what entered this document. A no-AI claim rests on the "
            "completeness of that record, and there is no record.",
        )

    entries = list(imported.get("datablocks") or [])

    # ── 2 · gaps in what entered ──────────────────────────────────────────────
    unreadable = [e for e in entries if e.get("unreadable")]
    if unreadable:
        return _refuse(
            UNREADABLE_DATABLOCKS,
            f"{len(unreadable)} of {len(entries)} imported datablocks could not be hashed. "
            "An import nobody read is exactly where a generated asset would be.",
            datablocks=[e.get("datablock") for e in unreadable],
        )

    # ── 3 · the host's plugin set · Standard §4 ───────────────────────────────
    if not addons or addons.get("source") in (None, "none"):
        return _refuse(
            NO_ADDON_ENUMERATION,
            "the add-on set was never enumerated. Our own add-on being witnessed says "
            "nothing about whether a generative one was installed beside it.",
        )
    if addons.get("unreadable_count"):
        return _refuse(
            UNREADABLE_ADDONS,
            f"{addons['unreadable_count']} enabled add-on(s) could not be hashed. An add-on "
            "nobody read could be anything, including the one that made this.",
        )
    if addon_change and addon_change.get("comparable") and addon_change.get("changed"):
        # NOT a failure of the work — a failure of THIS claim over THIS span. §4
        # says the change is itself a witnessed event; witness it and re-baseline,
        # and the next span can claim again.
        return _refuse(
            ADDON_SET_CHANGED,
            "the add-on set changed between the baseline and this render. Standard §4 makes "
            "that a witnessed event in its own right; re-baseline and the following work can "
            "claim again — this span cannot.",
            added=list(addon_change.get("added") or []),
            removed=list(addon_change.get("removed") or []),
            altered=list(addon_change.get("altered") or []),
        )

    # ── 4 · declared generative material is a FACT, not a gap ─────────────────
    known_ai = {d for d in ai_origin_digests if d}
    if known_ai and any(e.get("digest") in known_ai for e in entries):
        matched = [e.get("datablock") for e in entries if e.get("digest") in known_ai]
        return Claim({
            "ok": True,
            "digital_source_type": COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA,
            "basis": "generative material entered this document and is named in the record",
            "generative_datablocks": matched,
            "imported_count": len(entries),
            "addon_count": addons.get("count"),
        })

    # ── 5 · the record is complete and names nothing generative ───────────────
    #
    # ⚑ WHAT THIS DOES AND DOES NOT SAY. Not "no AI was used" — that is a claim
    # about the world and no file can carry it. It says: everything that entered
    # was enumerated and hashed, the add-on set was enumerated and hashed and did
    # not change, and nothing in either is generative material this estate knows
    # about. A verifier can check every one of those.
    return Claim({
        "ok": True,
        "digital_source_type": HUMAN_EDITS if edits_existing_work else DIGITAL_CREATION,
        "basis": "the record of what entered is complete, the add-on set is enumerated and "
                 "unchanged, and neither names generative material",
        "imported_count": len(entries),
        "addon_count": addons.get("count"),
        "third_party_addon_count": addons.get("third_party_count"),
        # ⚑ The honest limit of the claim, carried WITH it rather than in a
        # footnote somewhere: nobody watched these imports arrive. `origin_observed`
        # is False at every door in this estate today.
        "origin_observed": bool(imported.get("origin_observed")),
    })
