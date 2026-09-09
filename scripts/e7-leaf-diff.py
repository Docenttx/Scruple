#!/usr/bin/env python3
"""WO-E7 — three leaves, three products, one column-by-column verdict.

    python3 scripts/e7-leaf-diff.py --a <leaf> --b <leaf> --c <leaf>
    python3 scripts/e7-leaf-diff.py --a <leaf> --b <leaf> --c <leaf> --self-control

  A  the ADD-ON ALONE      — /data/scruple-blender talking to the server, no gate
  B  DESKTOP STUDIO ALONE  — the gate in the path, nobody registered on the hook
  C  BOTH                  — the gate in the path and the add-on announcing

The work order asks that "the three leaves differ only in the fields the table
in docs/BLENDER.md predicts, and no two of them read the same where they should
differ". "Only" is the hard half, and it is not provable by listing the fields
that came out interesting: EVERY column of `iterations` is classified below, and
a column this file does not name is a FAILURE rather than a silence. The next
migration that adds one forces somebody to decide which of the five classes it
is in.

THE FIVE CLASSES

  AXIS       a claim in BLENDER.md's table, with the pattern it must read in.
  AGREE      must read the SAME on all three. These are what make the three
             comparable at all: same leaf kind, same canonicalization, same
             witness state. A difference here means the comparison is between
             two different kinds of record and the rest of the table is moot.
  PRODUCT    names WHICH PRODUCT made the leaf. Differs A vs B/C and is
             SUPPOSED to: they are two integrations with two baselines and two
             tenants. Reported rather than excluded, because it is the only
             place a verifier can learn which product it is holding.
  IDENTITY   differs by construction and carries no claim about the AI step:
             row ids, timestamps, digests of these particular bytes.
  UNPREDICTED  a REAL difference that BLENDER.md's table does not predict.
             Asserted to be present, so that it stays visible, and written up
             in docs/WO-E7.md rather than folded into one of the classes above.

⚑ `--self-control` feeds the SAME leaf in as A and as B. Every check that is
supposed to tell those two apart must then go RED. A comparator that cannot
fail proves nothing about three leaves that happen to differ.
"""

import argparse
import json
import subprocess
import sys

DB = "/mnt/corpus/scruple-council-impl/scruple-scratch.db"

# ---- the classification -------------------------------------------------
#
# `AXIS` entries carry the pattern as three predicates, one per leaf, and the
# sentence from BLENDER.md that they are testing.

def is_null(v):
    return v is None or v == ""


AXES = [
    {
        "claim": "byte coverage of the AI step",
        "row": "addon-only: none · desktop-only: complete · both: complete",
        "how": "the CAPTURE BLOCK. A leaf a component emitted carries one; a leaf a "
               "plugin emitted has no capture block at all, so every column of it is "
               "NULL — migration 058's 'the question was never asked of this leaf'.",
        "columns": [
            "attestation_basis", "attestation_profile",
            "storage_confinement", "storage_confinement_source",
            "upstream_identity", "upstream_continuity",
            "upstream_uncaptured_reason", "upstream_source",
            "uncaptured_enumeration_method", "uncaptured_scope", "uncaptured_scope_source",
            "declared_uncaptured", "declared_uncaptured_hash", "declared_uncaptured_count",
            "component_id", "component_counter",
            "resolution_witness_endpoint", "resolution_settlement_deadline",
            "resolution_retention_policy_digest",
            "settlement_clock", "settlement_clock_authority", "settlement_observed_at",
            "evidence_retained_until",
            "input_hash",
        ],
        "pattern": "A-null-B-set-C-set",
    },
    {
        "claim": "byte coverage of the AI step — the producer's own MAC",
        "row": "addon-only: unverified · desktop-only: verified · both: verified",
        "how": "`component_verified` is 0 and NOT NULL for a submission with no §4.3 "
               "envelope, so it reads 0 for the add-on rather than being absent.",
        "columns": ["component_verified"],
        "pattern": "A=0-B=1-C=1",
    },
    {
        "claim": "model fingerprints",
        "row": "addon-only: no · desktop-only: yes · both: yes",
        "how": "computed by the DESKTOP from the model files ComfyUI loaded. ⚑ B and C "
               "must read IDENTICALLY: two runs that loaded the same weights must "
               "agree on them byte for byte, or the field is not reading the weights.",
        "columns": ["model_fingerprints", "model_fingerprints_hash"],
        "pattern": "A-null-B-set-C-set-and-B-equals-C",
    },
    {
        "claim": "the graph",
        "row": "addon-only: NO · desktop-only: yes · both: yes",
        "how": "⚑ THE TABLE IS WRONG AT THE COLUMN LEVEL AND THIS ASSERTS THE "
               "MEASUREMENT. `workflow_hash` is non-null on ALL THREE: the add-on "
               "sends a graph too — its own render-settings dict — and the column, "
               "the canonicalization profile and the leaf kind are the same ones the "
               "gate uses for a ComfyUI graph. The graph itself is not stored, so "
               "nothing on the leaf says which kind it was. Finding E7-1.",
        "columns": ["workflow_hash"],
        "pattern": "all-set-all-distinct",
    },
    {
        "claim": "scene semantics",
        "row": "addon-only: yes · desktop-only: no (blind) · both: yes (supplied)",
        "how": "the five host fields and the document. ⚑ A reads NULL and not `blind`: "
               "`host_semantics` is never null on a leaf a COMPONENT emits, and the "
               "add-on is not a component. So the record does not distinguish 'this "
               "artifact had no AI step' from 'nobody asked'. Finding E7-1.",
        "columns": ["host", "host_adapter", "host_evidence_type",
                    "host_evidence", "host_evidence_hash"],
        "pattern": "A-null-B-null-C-set",
    },
    {
        "claim": "scene semantics — the declared level",
        "row": "addon-only: (nothing) · desktop-only: blind · both: supplied",
        "how": "the one field HOST-HOOK.md is built around. B DECLARES its blindness; "
               "A declares nothing at all.",
        "columns": ["host_semantics"],
        "pattern": "A-null-B-blind-C-supplied",
    },
]

AGREE = {
    "leaf_kind": "both products emit a `workflow` leaf, and a reader cannot use this to tell them apart",
    "output_kind": "an image is an image",
    "output_content_type": "the add-on declares image/png for a PNG render; the gate declares it from the response",
    "witnessed": "all three reached the witness",
    "canonicalization_profile": "jcs-2 on all three — the same canonicalizer produced all three workflow hashes",
    "leaf_signature_state": "🔴 unsigned on all three: the scratch witness runs with H-1 signing disabled (STATE.md §4.1)",
    "mime_declared": "all three declared a type; none of them fell back",
    "input_artifacts": "an empty list on all three — no leaf here names an upstream artifact",
    "seal_state": "undeclared on all three",
    "workflow_publication": "full on all three",
    "prompt": "the route's own summary line, `<kind> · <mime>`",
    "output_bytes": "0 on all three — this column is not filled by either door",
    # Columns that are NULL on all three and are named so that a future writer
    # filling one of them shows up as a change rather than as a surprise.
    "previous_hash": "unused by both doors",
    "control_index": "unused by both doors",
    "metadata": "unused by both doors",
    "source_file": "unused by both doors",
    "image_filename": "unused by both doors",
    "provider": "v0 field, unused",
    "provider_job_id": "v0 field, unused",
    "execution_backend": "v0 field, unused",
    "execution_attestation": "v0 field, unused",
    "storage_pointer": "v0 field, unused",
    "compute_machine_id": "v0 field, unused",
    "platform_attestation_json": "v0 field, unused",
    "platform_attestation_verified": "v0 field, unused",
    "platform_attestation_status": "v0 field, unused",
    "container_machine_manifest": "v0 field, unused",
    "continuity_json": "neither door sent a continuity block on these runs",
    "modalities_requested": "no paid action on any of the three",
    "modalities_applied": "no paid action on any of the three",
    "modalities_outstanding": "no paid action on any of the three",
    "watermark_derivative_hash": "no watermark on any of the three",
    "watermark_payload_hex": "no watermark on any of the three",
    "watermark_scheme_version": "no watermark on any of the three",
    "watermark_tier": "no watermark on any of the three",
    "watermark_signed_at": "no watermark on any of the three",
    "watermark_derivative_leaf_hash": "no watermark on any of the three",
    "watermark_derivative_witness_id": "no watermark on any of the three",
    "watermark_derivative_run_sequence": "no watermark on any of the three",
    "watermark_derivative_witness_timestamp": "no watermark on any of the three",
    "watermark_derivative_prev_record_hash": "no watermark on any of the three",
    "watermark_derivative_leaf_scheme": "no watermark on any of the three",
    "watermark_derivative_witness_signature": "no watermark on any of the three",
    "machine_manifest_source": "NULL on all three",
    "model_fingerprints_state": "NULL on all three — the per-leaf column, not the per-file `state` inside the document",
    "model_fingerprints_error": "NULL on all three",
    "leaf_signature": "🔴 NULL on all three — see leaf_signature_state",
    "leaf_signer_key_id": "🔴 NULL on all three",
    "leaf_signature_alg": "🔴 NULL on all three",
    "leaf_signer_surrogate": "🔴 NULL on all three",
    "deployment_id": "NULL on all three",
    "seal_ref": "NULL on all three",
    "resolution_witness_authority": "NULL on all three",
    "resolution_checkpoint_id": "NULL on all three — no checkpoint is claimed anywhere in this sandbox (WO-C6)",
    "resolution_prev_checkpoint_id": "NULL on all three",
    "resolution_prev_checkpoint_quote_time": "NULL on all three",
    "upstream_epoch": "NULL on all three",
    "upstream_low_watermark_open": "NULL on all three",
    "upstream_low_watermark_close": "NULL on all three",
}

PRODUCT = {
    "baseline_hash": "⚑ THE ONE COLUMN THAT NAMES WHICH PRODUCT MADE THE LEAF. It is the "
                     "tamper surface hash of the integration that submitted: the add-on's "
                     "own files for A, `app/comfy/` for B and C. A verifier can tell the two "
                     "products apart — but only by resolving this against a baseline "
                     "registry, never off the leaf alone.",
    "project_id": "two tenants, because two products signed in with two keys",
}

IDENTITY = {
    "id": "row id",
    "run_sequence": "per-tenant sequence",
    "timestamp": "when",
    "witness_timestamp": "when",
    "settlement_observed_at": "when (also an AXIS column; listed there)",
    "leaf_hash": "the digest of this leaf's own preimage",
    "output_hash": "the digest of THESE bytes",
    "witness_id": "the witness's id for this leaf",
    "witness_signature": "the transport seal over this leaf",
}

UNPREDICTED = {
    "leaf_scheme": {
        "expect": "A differs from B, and B equals C",
        "say": "⚑ THE TWO PRODUCTS EMIT DIFFERENT LEAF SCHEMES — `v2.2` from the add-on, "
               "`v2` from the component. A leaf scheme governs which fields enter the "
               "preimage and in what order, so these two leaves are not merely "
               "differently populated, they are differently CONSTRUCTED. "
               "docs/BLENDER.md's table does not predict this. Finding E7-5.",
    },
    "machine_manifest_hash": {
        "expect": "A is set and B and C are null",
        "say": "⚑ AND IT POINTS THE OTHER WAY. The add-on sends a machine manifest "
               "(Blender version, enabled add-ons, the workflow) and the DESKTOP "
               "component sends none — so on this one column the standalone product "
               "records MORE than the gated one. Not in the table either. Finding E7-6.",
    },
}


def read(leaf_id):
    out = subprocess.check_output(
        ["sqlite3", f"file:{DB}?mode=ro", "-json",
         f"SELECT * FROM iterations WHERE id={int(leaf_id)};"])
    rows = json.loads(out or "[]")
    if not rows:
        raise SystemExit(f"no leaf {leaf_id} in {DB}")
    return rows[0]


def short(v, n=30):
    if v is None:
        return "NULL"
    s = str(v)
    if s == "":
        return "''"
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--c", required=True)
    ap.add_argument("--self-control", action="store_true")
    args = ap.parse_args()

    A, B, C = read(args.a), read(args.b), read(args.c)
    if args.self_control:
        # A becomes a SECOND COPY of B. Every check that is supposed to tell the
        # add-on's leaf from the desktop's must now fail.
        A = dict(B)

    cols = list(A.keys())
    ok, fail = [], []

    def check(label, cond, detail=""):
        (ok if cond else fail).append((label, detail))
        print(f"   {'ok  ' if cond else 'FAIL'}  {label:66} {detail}")

    print(f"\n══ THE THREE LEAVES")
    print(f"   A  addon alone      leaf {args.a}")
    print(f"   B  desktop alone    leaf {args.b}")
    print(f"   C  both             leaf {args.c}"
          + ("    ⚑ SELF-CONTROL: A is a copy of B" if args.self_control else ""))

    claimed = set()

    print(f"\n══ THE AXES — docs/BLENDER.md's table, column by column")
    for ax in AXES:
        print(f"\n   ── {ax['claim']}")
        print(f"      table says: {ax['row']}")
        for col in ax["columns"]:
            claimed.add(col)
            a, b, c = A[col], B[col], C[col]
            p = ax["pattern"]
            if p == "A-null-B-set-C-set":
                cond = is_null(a) and not is_null(b) and not is_null(c)
            elif p == "A=0-B=1-C=1":
                cond = a == 0 and b == 1 and c == 1
            elif p == "A-null-B-set-C-set-and-B-equals-C":
                cond = is_null(a) and not is_null(b) and not is_null(c) and b == c
            elif p == "all-set-all-distinct":
                cond = (not is_null(a) and not is_null(b) and not is_null(c)
                        and len({a, b, c}) == 3)
            elif p == "A-null-B-null-C-set":
                cond = is_null(a) and is_null(b) and not is_null(c)
            elif p == "A-null-B-blind-C-supplied":
                cond = is_null(a) and b == "blind" and c == "supplied"
            else:
                raise SystemExit(f"unknown pattern {p}")
            check(f"{col}  [{p}]", cond, f"A={short(a,22)}  B={short(b,22)}  C={short(c,22)}")

    print(f"\n══ MUST AGREE — what makes the three comparable at all")
    for col, why in AGREE.items():
        claimed.add(col)
        a, b, c = A[col], B[col], C[col]
        check(f"{col}", a == b == c, f"= {short(a,24)}")

    print(f"\n══ WHICH PRODUCT — differs A vs B/C, and is supposed to")
    for col, why in PRODUCT.items():
        claimed.add(col)
        a, b, c = A[col], B[col], C[col]
        check(f"{col}", (a != b) and (b == c) if not args.self_control else (a != b),
              f"A={short(a,20)}  B={short(b,20)}  C={short(c,20)}")

    print(f"\n══ ⚑ DIFFERENCES THE TABLE DOES NOT PREDICT — asserted so they stay visible")
    for col, spec in UNPREDICTED.items():
        claimed.add(col)
        a, b, c = A[col], B[col], C[col]
        if col == "leaf_scheme":
            cond = (a != b) and (b == c)
        else:
            cond = (not is_null(a)) and is_null(b) and is_null(c)
        check(f"{col}  [{spec['expect']}]", cond,
              f"A={short(a,20)}  B={short(b,20)}  C={short(c,20)}")

    print(f"\n══ IDENTITY — differs by construction, carries no claim about the AI step")
    for col, why in IDENTITY.items():
        claimed.add(col)

    print(f"\n══ COMPLETENESS — every column of `iterations` is in exactly one class")
    unclaimed = [c for c in cols if c not in claimed]
    check("no column of `iterations` is unclassified", not unclaimed,
          f"{len(cols)} columns, {len(unclaimed)} unclassified"
          + (f": {unclaimed}" if unclaimed else ""))

    print(f"\n══ VERDICT")
    if args.self_control:
        # The self-control PASSES when the checks that distinguish A from B FAIL.
        print(f"   {len(fail)} checks went RED with A replaced by a copy of B.")
        if fail:
            print("   ⚑ THE COMPARATOR CAN FAIL. Reddened:")
            for lbl, _ in fail:
                print(f"      RED  {lbl}")
            return 0
        print("   FAIL — the comparator did not notice that A and B were the same leaf.")
        return 1

    print(f"   {len(ok)} ok / {len(fail)} FAIL")
    return 0 if not fail else 1


sys.exit(main())
