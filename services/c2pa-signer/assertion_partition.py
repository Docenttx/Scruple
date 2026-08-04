"""Scruple Signer — assertion partition (TOE boundary enforcement).

Per GPSA §C.2.4, every entry in `created_assertions` on a Scruple-signed
manifest must be authored by code executing inside the attested Signer
TOE. Client-supplied assertion payloads reach the Signer as part of the
job spec's `manifest['assertions']` list; this module partitions that
list into:

  - created:  assertions the Signer will place in `created_assertions`
              (label matches CREATED_ALLOWLIST; SDK will treat them
              per the `created_assertion_labels` setting in sign.py)
  - gathered: assertions the Client wants preserved with the asset but
              which are of external / untrusted provenance — placed in
              `gathered_assertions` where the C2PA v2.x semantics
              honestly label them as such

Anything with an unrecognized label (not in either allowlist) is
REJECTED — the Signer refuses to sign rather than silently drop or
guess placement. This is a fail-closed boundary.

Every partition decision is captured in a machine-readable audit record
that sign.py emits to stderr as one line per manifest; that line is
picked up by HIDS per §C.2.6.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple


# C2PA-standard assertion labels that the Signer will place in
# `created_assertions`. These correspond to the SDK-emitted assertions
# (see services/c2pa-signer/sign.py:_settings.builder.created_assertion_labels)
# plus the Scruple-namespaced runtime assertion which is added by
# signer_runtime.runtime_assertion() and is Scruple-authored inside the TOE.
CREATED_ALLOWLIST = frozenset({
    # C2PA-standard, SDK-authored
    "c2pa.actions",
    "c2pa.thumbnail.claim",
    "c2pa.thumbnail.ingredient",
    "c2pa.ingredient",
    "c2pa.hash.data",
    "c2pa.hash.boxes",
    # Scruple-authored inside TOE (base label; matches .vN suffix at runtime)
    "ai.scruple.signer-runtime",
})

# Labels the Client may legitimately want to preserve alongside the asset
# even though their content originated outside the TOE. These land in
# `gathered_assertions` where the C2PA v2.x block semantics honestly
# label the provenance as external. Add labels here only after
# reviewing the Client-supplied schema.
GATHERED_ALLOWLIST = frozenset({
    # Explicitly external provenance markers the caller may pass through
    "stds.schema-org.CreativeWork",
    "stds.iptc",
    "stds.exif",
})


def _label_of(assertion: Any) -> str:
    if not isinstance(assertion, dict):
        return ""
    lab = assertion.get("label")
    return lab if isinstance(lab, str) else ""


def _base_label(label: str) -> str:
    """Strip a trailing `.vN` version suffix so allowlist matching is
    version-insensitive (matches the c2pa-rs `created_assertion_labels`
    convention documented in sign.py)."""
    if not label:
        return label
    parts = label.rsplit(".", 1)
    if len(parts) == 2 and len(parts[1]) >= 2 and parts[1][0] == "v" and parts[1][1:].isdigit():
        return parts[0]
    return label


def partition_assertions(
    assertions: List[Any],
) -> Tuple[Dict[str, List[Any]], Dict[str, Any]]:
    """Partition an incoming assertions list into created / gathered /
    rejected. Returns (partition, audit_record).

    partition = {"created": [...], "gathered": [...]}
    audit_record = {
        "created_count": N,
        "gathered_count": N,
        "rejected_count": N,
        "created_labels": [...],
        "gathered_labels": [...],
        "rejected_labels": [...],
        "rejected_reason": str,  # first rejection reason if any
    }

    Any assertion with a label that is neither on CREATED_ALLOWLIST nor
    GATHERED_ALLOWLIST raises ValueError — this is a fail-closed boundary;
    the Signer must not silently accept unknown labels.
    """
    created: List[Any] = []
    gathered: List[Any] = []
    rejected_labels: List[str] = []
    rejected_reasons: List[str] = []

    created_labels: List[str] = []
    gathered_labels: List[str] = []

    for ass in assertions:
        lab = _label_of(ass)
        if not lab:
            rejected_labels.append("<missing>")
            rejected_reasons.append("assertion missing 'label' field")
            continue
        base = _base_label(lab)
        if base in CREATED_ALLOWLIST:
            created.append(ass)
            created_labels.append(lab)
        elif base in GATHERED_ALLOWLIST:
            gathered.append(ass)
            gathered_labels.append(lab)
        else:
            rejected_labels.append(lab)
            rejected_reasons.append(
                f"label '{lab}' not on Signer TOE allowlist "
                f"(CREATED or GATHERED); refusing to place in a signed manifest"
            )

    if rejected_labels:
        raise ValueError(
            "assertion_partition: refusing to sign — "
            + rejected_reasons[0]
            + f" (all rejected labels: {rejected_labels})"
        )

    return (
        {"created": created, "gathered": gathered},
        {
            "created_count": len(created),
            "gathered_count": len(gathered),
            "rejected_count": 0,
            "created_labels": created_labels,
            "gathered_labels": gathered_labels,
            "rejected_labels": [],
            "rejected_reason": "",
        },
    )
