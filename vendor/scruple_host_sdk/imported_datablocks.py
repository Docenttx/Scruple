"""``imported_datablocks`` — what entered a document from outside it, and that
nobody here watched it arrive.

WO-F3, closing WO-E7 finding **E7-1** — the finding the E series ends on.
`lib/capture/importedDatablocks.ts` is the validator this file must satisfy and
`lib/db/migrations/060_imported_datablocks.sql` carries the product decision;
neither is restated here. What this module owns is the half a HOST ADAPTER
cannot be asked to get right on its own:

    THE DOCUMENT'S SHAPE, THE DIGEST OVER IT, AND THE FIVE SIGNED SCALARS
    DERIVED FROM IT — so an adapter names datablocks and this file decides what
    the wire carries.

⚑ THE SCALARS ARE DERIVED, NEVER DECLARED. ``wire_fields()`` computes the
count, the unreadable count and the digest FROM the document it is about to
send. An adapter that could pass its own count could pass one that disagreed
with its own list, and the server would refuse the submission — correctly, and
at the cost of a capture. The two claims the adapter really does own,
``source`` and ``origin_observed``, ride in the document and are lifted out of
it, so there is exactly one place each value is written down.

⚑ AND ``origin_observed`` IS NOT A FLAG WITH A DEFAULT. It is the answer to
"did the party that produced this leaf watch these assets arrive", it is
``False`` for every door in this estate today (the server refuses ``True``, and
`importedDatablocks.ts` carries the named blocker and why), and it has to be
passed explicitly. A default would make the one claim this field exists to
carry the one nobody had to think about.

⚑ WHY AN UNREADABLE DATABLOCK IS A MEMBER AND NOT AN OMISSION. WO-D3's rule,
one field over: the refusal keeps the member and refuses only the claim. A
datablock whose bytes are gone is still a fact about what this document
references, and dropping it would make an unreadable import look exactly like
no import — which is the reading E7-1 is about.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any, Dict, List, Mapping, Optional, Sequence

from scruple_api import canonical as _canonical

#: ``imported_datablocks_source``. How the set was obtained. ``NONE`` is not an
#: empty set: it is the absence of an enumeration, and it is what a door with no
#: datablock table to ask declares.
HOST_DATABLOCKS = "host_datablocks"
SOURCE_NONE = "none"
SOURCES = (HOST_DATABLOCKS, SOURCE_NONE)

#: What was hashed, for a verifier who wants to re-hash it. Two values because
#: there are two places a host can hold the bytes, and they are not the same
#: claim: the copy inside the document, or the file the datablock points at.
DIGEST_OF_PACKED = "packed_bytes"
DIGEST_OF_SOURCE_FILE = "source_file_bytes"

#: ``unreadable``. Why a declared datablock carries no digest. Free-form on the
#: wire; these are the ones an enumerator on a filesystem can actually reach,
#: named here so three adapters do not invent three spellings.
UNREADABLE_NO_SOURCE = "no_source_path"
UNREADABLE_MISSING = "source_file_missing"
UNREADABLE_ERROR = "source_file_unreadable"

#: The scalars a submission that enumerated nothing carries. Named once, here,
#: so it cannot drift into a default written at three call sites — the shape
#: ``declared_uncaptured.UNENUMERATED`` uses next door, for the same reason.
UNENUMERATED: Dict[str, Any] = {"imported_datablocks_source": SOURCE_NONE}


#: The bound on hashing an imported datablock, and it is NOT the inline
#: payload limit next door. `capture.INLINE_PAYLOAD_LIMIT_BYTES` bounds what
#: travels in a request body; this bounds what a HOST HOOK is willing to read
#: off disk on a save, which is a latency question rather than a wire one — the
#: add-on's handlers run on Blender's own worker and a user is waiting.
#:
#: ⚑ A DATABLOCK OVER THE BOUND IS A MEMBER WITH NO DIGEST, never an omission.
#: `over_digest_limit` is one of the reasons a member carries no digest, beside
#: the file being missing or unreadable, and it is on the record for the same
#: reason: an import nobody hashed must not look like no import.
IMPORTED_DIGEST_LIMIT_BYTES = 64 * 1024 * 1024

UNREADABLE_OVER_LIMIT = "over_digest_limit"


def digest_bytes(data: bytes) -> str:
    """sha256 over bytes a host already holds — a packed datablock's copy."""
    return hashlib.sha256(bytes(data)).hexdigest()


def digest_file(
    path: Optional[str], *, limit: int = IMPORTED_DIGEST_LIMIT_BYTES
) -> Dict[str, Any]:
    """Hash the file a datablock points at, or say why there is no digest.

    Returns ``{"digest", "bytes", "unreadable"}`` with exactly one of
    ``digest``/``unreadable`` set, which is the shape :func:`entry` requires.
    THE ERROR IS A VALUE, not an exception: a missing texture is an ordinary
    state of a real .blend, and an enumerator that raised on one would turn a
    complete-but-partly-unreadable declaration into no declaration at all.

    ⚑ It reads the file rather than trusting the host's own idea of the size,
    and the two are not the same claim: `Image.size` is the decoded pixel
    dimensions, and what a digest has to cover is the bytes.
    """
    if not path:
        return {"digest": None, "bytes": None, "unreadable": UNREADABLE_NO_SOURCE}
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"digest": None, "bytes": None, "unreadable": UNREADABLE_MISSING}
    if size > limit:
        return {"digest": None, "bytes": int(size), "unreadable": UNREADABLE_OVER_LIMIT}
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return {"digest": None, "bytes": int(size), "unreadable": UNREADABLE_ERROR}
    return {"digest": h.hexdigest(), "bytes": int(size), "unreadable": None}


def entry(
    *,
    datablock: str,
    type: str,
    origin: str,
    packed: bool,
    filename: Optional[str],
    bytes_: Optional[int],
    digest: Optional[str] = None,
    digest_of: Optional[str] = None,
    unreadable: Optional[str] = None,
) -> Dict[str, Any]:
    """One declared datablock.

    Raises ``ValueError`` for the two shapes the server refuses, rather than
    sending them: a member with both a digest and a reason it has none, and a
    member with neither. Exactly one — a digest is what the bytes were, an
    ``unreadable`` reason is why there are none to hash, and both together is a
    claim about bytes nobody read.

    ``filename`` is a BASENAME, and the caller is trusted to have made it one:
    a leaf is not the place for a user's directory layout. What binds the
    member to bytes is the digest, not the path.
    """
    if (digest is None) == (unreadable is None):
        raise ValueError(
            f"datablock {datablock!r} must carry exactly one of `digest` or `unreadable`; "
            f"got digest={digest!r}, unreadable={unreadable!r}. Both is a claim about bytes "
            "nobody read; neither is a member that says nothing at all."
        )
    if digest is not None and not digest_of:
        raise ValueError(
            f"datablock {datablock!r} carries a digest with no `digest_of`. A verifier "
            "re-hashing this has to know WHICH bytes were hashed."
        )
    return {
        "datablock": str(datablock),
        "type": str(type),
        "origin": str(origin),
        "packed": bool(packed),
        "filename": filename,
        "bytes": None if bytes_ is None else int(bytes_),
        "digest": digest,
        "digest_of": digest_of if digest is not None else None,
        "unreadable": unreadable,
    }


def declaration(
    entries: Sequence[Mapping[str, Any]],
    *,
    datablock_types: Sequence[str],
    origin_observed: bool,
) -> Dict[str, Any]:
    """The document.

    ``datablock_types`` is THE SCOPE THE ENUMERATION RANGED OVER and is
    required: without it "nothing came from outside" cannot be told apart from
    "nothing came from outside of the one kind anybody looked at". WO-E2's rule
    — the completeness of a set is itself a fact and needs a scope — applied to
    a document instead of to a history ring.

    An EMPTY ``entries`` is legitimate and is not the same as declaring
    nothing: it is "the datablocks were enumerated and none came from outside",
    which reaches the leaf as a count of 0 and a document that is PRESENT.
    """
    if not datablock_types:
        raise ValueError(
            "declaration() requires `datablock_types` — the datablock tables that were "
            "enumerated. An absence with no scope asserts a closure it does not have."
        )
    return {
        "source": HOST_DATABLOCKS,
        "origin_observed": bool(origin_observed),
        "datablock_types": [str(t) for t in datablock_types],
        "datablocks": [dict(e) for e in entries],
    }


def document_hash(doc: Mapping[str, Any]) -> str:
    """sha256 over the document's canonical form — ONE canonicalizer, the same
    one the route uses (RFC 8785, profile ``jcs-2``). A second formula here
    would be a second preimage that looks like the first until a verifier tries
    to reproduce one."""
    return hashlib.sha256(_canonical.canonicalize_bytes(dict(doc))).hexdigest()


def wire_fields(doc: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """The document and its five scalars, ready to merge into a submission.

    ``None`` yields ``UNENUMERATED``: a door that has no datablock table to
    enumerate says so, which is a different fact from a door that said nothing
    (every leaf written before WO-F3, which is NULL across all five columns).
    """
    if doc is None:
        return dict(UNENUMERATED)
    members: List[Mapping[str, Any]] = list(doc.get("datablocks") or [])
    return {
        "imported_datablocks": dict(doc),
        "imported_datablocks_source": doc.get("source", HOST_DATABLOCKS),
        "imported_origin_observed": bool(doc.get("origin_observed")),
        "imported_datablocks_count": len(members),
        "imported_datablocks_unreadable_count": sum(
            1 for m in members if m.get("digest") is None
        ),
        "imported_datablocks_hash": document_hash(doc),
    }
