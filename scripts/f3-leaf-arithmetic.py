"""The two recomputations WO-F3's control (c) rests on, done from the shell.

    python3 scripts/f3-leaf-arithmetic.py input-hash  <declaration-digest>
    python3 scripts/f3-leaf-arithmetic.py leaf-hash   <witness.db> <leaf_hash>
    python3 scripts/f3-leaf-arithmetic.py leaf-hash-with <witness.db> <leaf_hash> <input_hash>

WHY IT EXISTS. The work order's control (c) is "the field is in the MAC —
changing a digest must move the leaf hash". Two facts have to be established
for that to be a measurement rather than a claim, and neither can be read off a
column:

  1. `input_hash` on an add-on leaf IS the fold of the declaration's digest, and
     it is reproducible OUTSIDE the server. Recomputed here with the SDK's own
     Python canonicalizer (RFC 8785, profile `jcs-2`) — a different
     implementation in a different language from the TypeScript that wrote it.

  2. `input_hash` is inside the hash the WITNESS signed. Recomputed here from
     the witness's own sqlite row, through the `v2.2` canonical record
     (`/opt/scruple-witness/server.js:318` — eight fields, fixed order,
     `JSON.stringify`). If the recomputation reproduces the stored `leaf_hash`,
     then a changed `input_hash` provably changes the leaf hash, and
     `leaf-hash-with` shows it by substituting one.

🔴 The witness database is opened READ-ONLY and only ever the scratch one the
caller names. Nothing here writes.
"""

import hashlib
import json
import os
import sqlite3
import sys

sys.path.insert(0, "/data/scruple-blender/vendor")
from scruple_api import canonical as _canonical  # noqa: E402
from scruple_host_sdk import imported_datablocks as _imported  # noqa: E402

IMPORTED_KIND = _imported and "imported_datablocks"


def input_hash_for(digest: str) -> str:
    """`hashRunInputs` over the one ref the route folds in.

    The wrapper is `{provider, prompt, spec, inputs}` with every field null
    except `inputs`, and each input reduced to `{kind, hash}` — lib/leaf/hashes.ts,
    and the canonicalizer sorts, so the wrapper's own key order is irrelevant.
    """
    payload = {
        "provider": None,
        "prompt": None,
        "spec": None,
        "inputs": [{"kind": IMPORTED_KIND, "hash": digest}],
    }
    return hashlib.sha256(_canonical.canonicalize_bytes(payload)).hexdigest()


def v22_record(row, input_hash=None):
    """The witness's `canonicalRecordV22`, transcribed. Eight fields, fixed
    order, JSON.stringify. Every value is a hex digest, an integer or an ISO
    timestamp, so Python's compact `json.dumps` is byte-identical to V8's."""
    ordered = {
        "run_sequence": row["run_sequence"],
        "output_hash": row["content_hash"] or "",
        "input_hash": (row["input_hash"] if input_hash is None else input_hash) or "",
        "workflow_hash": row["workflow_hash"] or "",
        "model_fingerprints_hash": row["model_fingerprints_hash"] or "",
        "machine_manifest_hash": row["machine_manifest_hash"] or "",
        "server_timestamp": row["server_timestamp"],
        "prev_record_hash": row["prev_record_hash"] or "",
    }
    text = json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)
    return text, hashlib.sha256(text.encode("utf-8")).hexdigest()


def witness_row(db, leaf_hash):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM witnesses WHERE leaf_hash = ?", (leaf_hash,)).fetchone()
    con.close()
    if row is None:
        raise SystemExit(f"no witness row for leaf_hash {leaf_hash}")
    return row


def main():
    mode = sys.argv[1]
    if mode == "input-hash":
        print(json.dumps({"kind": IMPORTED_KIND, "input_hash": input_hash_for(sys.argv[2])}))
        return
    row = witness_row(sys.argv[2], sys.argv[3])
    if mode == "leaf-hash":
        text, h = v22_record(row)
        print(json.dumps(
            {
                "leaf_scheme": row["leaf_scheme"],
                "stored_leaf_hash": row["leaf_hash"],
                "recomputed_leaf_hash": h,
                "matches": h == row["leaf_hash"],
                "input_hash_in_record": row["input_hash"],
                "canonical_record": text,
            }
        ))
        return
    if mode == "leaf-hash-with":
        _, base = v22_record(row)
        text, h = v22_record(row, input_hash=sys.argv[4])
        print(json.dumps(
            {
                "stored_leaf_hash": row["leaf_hash"],
                "recomputed_with_substituted_input_hash": h,
                "moved": h != row["leaf_hash"] and base == row["leaf_hash"],
                "canonical_record": text,
            }
        ))
        return
    raise SystemExit(f"unknown mode {mode}")


main()
