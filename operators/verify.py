"""Fetch the receipt and run the third-party check, from inside Blender.

WO-B3. gap.json, endpoints row 14: the addon had no verify path of any
kind -- `grep 'api/v2'` across the whole tree returned zero hits, so it
could not tell a user whether the leaf it had just produced was on the
record at all, let alone independently verifiable.

Two routes, both public and unauthenticated by design:

  GET /api/v2/receipt/{leaf_id}       "deliberately unflattering"
  GET /api/v2/verify/{content_hash}   the check a stranger would run

THE REPORT IS CAREFUL ABOUT ONE WORD. /api/v2/verify answers
`independently_verifiable`, and on 2026-09-07 it answered TRUE for a leaf
whose `leaf_signature` is NULL in the witness server's own database --
the route derives the flag from the HMAC (`witness_signature`), which is
a transport seal Scruple can forge and nobody else can check (H-2). So
this operator reports it as *what scruple.ai says*, never as something
this addon confirmed. See adapter/assurance.py.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import assurance as _assurance
from adapter import flow as _wf
from adapter import sdk as _sdk
from adapter import state as _state


def report_lines(rec) -> list:
    """The receipt, in the words the evidence supports. Shared with the
    panel so one place decides how a tier is phrased."""
    lines = [
        f"Leaf {rec.leaf_id or '-'} · {_assurance.sentence_for(rec.state)}",
        f"Assurance: {rec.assurance_tier}",
        f"Signature: {rec.signature.explanation}",
    ]
    if rec.independently_verifiable_claimed is not None:
        claim = "yes" if rec.independently_verifiable_claimed else "no"
        lines.append(
            f"scruple.ai says independently verifiable: {claim} "
            f"(basis: {rec.verification_basis_kind or 'not stated'}). "
            f"This addon has not checked it and holds no key with which to."
        )
    if rec.canonicalization.agrees is None:
        lines.append(
            f"Canonicalization: this client used {rec.canonicalization.client}; "
            f"the server does not disclose the profile it recorded."
        )
    elif not rec.canonicalization.agrees:
        lines.append(
            f"Canonicalization MISMATCH: client {rec.canonicalization.client}, "
            f"server {rec.canonicalization.server}."
        )
    return lines


if bpy is not None:

    class SCRUPLE_OT_verify_last(bpy.types.Operator):
        bl_idname = "scruple.verify_last"
        bl_label = "Fetch receipt & verify"
        bl_description = (
            "Fetch the public receipt for the last leaf and ask "
            "/api/v2/verify whether it is on the record"
        )

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in. Open Add-on Preferences to sign in.")
                return {"CANCELLED"}
            rec = _state.last_assurance()
            if rec is None:
                self.report({"WARNING"}, "Nothing captured this session yet.")
                return {"CANCELLED"}
            if not rec.leaf_id:
                self.report({"WARNING"}, _assurance.sentence_for(rec.state))
                return {"CANCELLED"}
            rec = _wf.resolve_assurance(client, rec)
            for line in report_lines(rec):
                self.report({"INFO"}, line)
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_verify_last,)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)

    def unregister():
        for cls in reversed(_CLASSES):
            try:
                bpy.utils.unregister_class(cls)
            except Exception:
                pass

else:

    def register():
        pass

    def unregister():
        pass
