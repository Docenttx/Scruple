"""``host_addons`` — the host application's whole plugin set, as a witnessed fact.

WO-G5. Standard **§4**: *changing an integration is itself a witnessed event*.

WHY THIS FILE IS THE CENTRE OF THE NO-AI CLAIM, AND NOT A NICE-TO-HAVE
----------------------------------------------------------------------------
Studio's market is proving that AI made something, and a signature over the
output is most of that. **This plugin's market is the opposite claim — that a
human made it without AI — and a signature proves nothing about it.** Absence is
not a property of the output file. Any gap in the record is exactly where the AI
step could have happened, so what carries a no-AI claim is CONTINUITY: an
unbroken account of what this Blender was and what entered it.

Our own add-on being witnessed is the easy half and the useless half. The
question a verifier actually has is *"was there an AI plugin in this Blender?"*,
and nothing about `scruple_blender` answers it. So the baseline covers **every
enabled add-on**, ours among them, and a change to that set is a witnessed
event like any other.

⚑ THIS MODULE DOES NOT DECIDE WHETHER AN ADD-ON IS "AN AI ADD-ON".
It enumerates and it hashes. Judging an add-on by its name would be a blocklist,
and a blocklist is a promise this project cannot keep: it is one rename away from
wrong, and its failure mode is a confident non-AI claim over a scene an unlisted
generator built. What the record supports is the honest, checkable statement —
*"these were the add-ons, here is the digest, and it did not change between the
baseline and the work"* — and a verifier who cares can read the list.
``source_type`` turns that into a claim, and refuses when it cannot.

WHAT IS HASHED
--------------
The module name, its version as the add-on declares it, and a digest over the
add-on's own files where they are reachable. The digest is what makes this more
than a list of names: an add-on can be edited in place without its version
changing, and a set that only recorded names would call that the same Blender.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Dict, List, Mapping, Optional, Sequence

from scruple_api import canonical as _canonical

#: The document's shape. Bumped when a field is added, so a verifier reading an
#: old leaf is not asked to guess which shape it has.
ADDON_SET_VERSION = 1

#: The bound on hashing one add-on's tree. An add-on over it is a member with no
#: digest and a reason, never an omission — the same rule `imported_datablocks`
#: applies to a datablock whose bytes are gone, and for the same reason: an
#: add-on nobody hashed must not look like no add-on.
#:
#: 🔴 THIS NUMBER WAS 32 MB AND IT MADE THE WHOLE PLUGIN USELESS. Blender ships
#: `cycles` — its own renderer — at 34 MB, so on a STOCK Blender one bundled
#: add-on was always unhashable, `source_type` always refused, and the no-AI
#: claim could never be made by anybody. The bound was written to keep a
#: pathological add-on from stalling a user, and it was quietly deciding the
#: product's central claim instead.
#:
#: 512 MB is chosen so that no add-on a person would actually install trips it,
#: and it is affordable because THIS READING IS NOT ON THE SAVE PATH: the set is
#: hashed when a baseline is taken and when a claim is made, not on every
#: handler. Anything still over it is a genuine gap and still refuses.
ADDON_DIGEST_LIMIT_BYTES = 512 * 1024 * 1024

UNREADABLE_NO_PATH = "no_module_path"
UNREADABLE_MISSING = "module_path_missing"
UNREADABLE_ERROR = "module_unreadable"
UNREADABLE_OVER_LIMIT = "over_digest_limit"

#: How the set was obtained. ``none`` is NOT an empty set — it is the absence of
#: an enumeration, and the two must never read alike. A Blender with no add-ons
#: enabled is a fact; a process that could not ask is not.
SOURCE_BPY_PREFERENCES = "bpy_preferences"
SOURCE_NONE = "none"

#: What a submission that could not enumerate carries.
UNENUMERATED: Dict[str, Any] = {"addon_set_source": SOURCE_NONE}


def _digest_tree(root: str) -> Dict[str, Any]:
    """sha256 over an add-on's files, in a stable order.

    Content and PATH both, because two add-ons with the same files under
    different names are not the same add-on, and a rename is a change §4 exists
    to catch. Compiled caches are skipped: `__pycache__` differs between two
    machines running byte-identical source, and a digest that changed when
    nothing did would make every reading a false alarm.
    """
    if not root:
        return {"digest": None, "bytes": None, "files": None, "unreadable": UNREADABLE_NO_PATH}
    if not os.path.exists(root):
        return {"digest": None, "bytes": None, "files": None, "unreadable": UNREADABLE_MISSING}

    h = hashlib.sha256()
    total = 0
    count = 0
    try:
        if os.path.isfile(root):
            paths = [(os.path.basename(root), root)]
        else:
            paths = []
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
                for fn in sorted(filenames):
                    if fn.endswith((".pyc", ".pyo")):
                        continue
                    full = os.path.join(dirpath, fn)
                    paths.append((os.path.relpath(full, root).replace(os.sep, "/"), full))
            paths.sort()
        for rel, full in paths:
            size = os.path.getsize(full)
            total += size
            if total > ADDON_DIGEST_LIMIT_BYTES:
                return {"digest": None, "bytes": total, "files": count,
                        "unreadable": UNREADABLE_OVER_LIMIT}
            h.update(rel.encode("utf-8"))
            h.update(b"\x00")
            with open(full, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    h.update(chunk)
            h.update(b"\x00")
            count += 1
    except OSError:
        return {"digest": None, "bytes": total, "files": count, "unreadable": UNREADABLE_ERROR}

    return {"digest": "sha256:" + h.hexdigest(), "bytes": total, "files": count, "unreadable": None}


def member(
    *,
    module: str,
    name: Optional[str],
    version: Optional[Sequence[int]],
    path: Optional[str],
    digest: Optional[str],
    bytes_: Optional[int],
    files: Optional[int],
    unreadable: Optional[str],
    is_scruple: bool,
) -> Dict[str, Any]:
    """One enabled add-on.

    Exactly one of ``digest`` or ``unreadable``, for the reason
    `imported_datablocks.entry` gives: both together is a claim about bytes
    nobody read, and neither is a member that says nothing.
    """
    if (digest is None) == (unreadable is None):
        raise ValueError(
            f"add-on {module!r} must carry exactly one of `digest` or `unreadable`; "
            f"got digest={digest!r}, unreadable={unreadable!r}."
        )
    return {
        "module": str(module),
        "name": name,
        "version": list(version) if version else None,
        # BASENAME of the containing directory, never the user's full path. What
        # binds the member is the digest; where it sits on their disk is not a
        # fact a leaf needs to carry.
        "path": os.path.basename(path.rstrip("/")) if path else None,
        "digest": digest,
        "bytes": None if bytes_ is None else int(bytes_),
        "files": None if files is None else int(files),
        "unreadable": unreadable,
        # Ours or someone else's. NOT a judgement about the add-on — it is how a
        # verifier tells the observer apart from the observed.
        "is_scruple": bool(is_scruple),
    }


def enumerate_addons() -> Optional[Dict[str, Any]]:
    """Every enabled add-on in this Blender, or ``None`` when there is no bpy."""
    try:
        import addon_utils  # type: ignore
        import bpy  # type: ignore
    except ImportError:
        return None

    enabled = set(getattr(bpy.context.preferences, "addons", {}).keys())
    members: List[Dict[str, Any]] = []
    for mod in addon_utils.modules():
        module_name = getattr(mod, "__name__", None)
        if not module_name or module_name not in enabled:
            continue
        info = getattr(mod, "bl_info", {}) or {}
        file_ = getattr(mod, "__file__", None)
        # A package add-on is a directory; a single-file one is the file. Hash
        # whichever it actually is.
        root = None
        if file_:
            root = os.path.dirname(file_) if os.path.basename(file_) == "__init__.py" else file_
        d = _digest_tree(root or "")
        members.append(
            member(
                module=module_name,
                name=info.get("name"),
                version=info.get("version"),
                path=root,
                digest=d["digest"],
                bytes_=d["bytes"],
                files=d["files"],
                unreadable=d["unreadable"],
                is_scruple=module_name.startswith("scruple"),
            )
        )

    members.sort(key=lambda m: m["module"])
    return declaration(members)


def declaration(members: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """The document, with its derived scalars."""
    ms = list(members)
    return {
        "addon_set_version": ADDON_SET_VERSION,
        "source": SOURCE_BPY_PREFERENCES,
        "addons": ms,
        # DERIVED, never declared — the rule `imported_datablocks.wire_fields`
        # sets: a caller who could pass its own count could pass one that
        # disagreed with its own list.
        "count": len(ms),
        "unreadable_count": sum(1 for m in ms if m.get("unreadable")),
        "third_party_count": sum(1 for m in ms if not m.get("is_scruple")),
    }


def document_hash(doc: Mapping[str, Any]) -> str:
    """The digest the baseline carries, over the canonical form."""
    return "sha256:" + hashlib.sha256(
        _canonical.canonicalize_bytes(dict(doc))
    ).hexdigest()


def wire_fields(doc: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """What a leaf carries about the add-on set.

    A document that could not be built sends ``UNENUMERATED`` — "nobody asked"
    — and NOT an empty set. `source_type` refuses a non-AI claim on the first
    and can make one on the second, which is the whole reason they are apart.
    """
    if not doc:
        return dict(UNENUMERATED)
    return {
        "addon_set_source": doc.get("source", SOURCE_NONE),
        "addon_set_count": doc.get("count"),
        "addon_set_unreadable_count": doc.get("unreadable_count"),
        "addon_set_third_party_count": doc.get("third_party_count"),
        "addon_set_digest": document_hash(doc),
    }


def changed(previous: Optional[Mapping[str, Any]], current: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """Did the plugin set change, and how.

    §4's mechanism. Returns the modules added, removed and altered-in-place —
    the third being the one a version number alone would miss, and the one an
    edit-in-place attack would use.
    """
    if not previous or not current:
        return {"comparable": False, "reason": "one side was never enumerated",
                "added": [], "removed": [], "altered": []}
    p = {m["module"]: m for m in previous.get("addons", [])}
    c = {m["module"]: m for m in current.get("addons", [])}
    added = sorted(set(c) - set(p))
    removed = sorted(set(p) - set(c))
    altered = sorted(
        m for m in (set(p) & set(c))
        if p[m].get("digest") != c[m].get("digest") or p[m].get("version") != c[m].get("version")
    )
    return {
        "comparable": True,
        "added": added,
        "removed": removed,
        "altered": altered,
        "changed": bool(added or removed or altered),
    }
