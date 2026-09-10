#!/usr/bin/env python3
"""WO-F4 — recompute every stored root from the label alone, independently.

The backfill in `/data/scruple-web/scripts/merkle-algorithm-backfill.mjs` and
the verifier in `packages/scruple-verify/src/core/storedRootAlgorithm.mjs` are
DELIBERATELY the same code: a backfill that can write a label its own verifier
rejects is the defect the column exists to prevent. That makes "the backfill
says all 15 verify" a statement about one implementation.

This is the second implementation. It shares nothing with the first — no
import, no vocabulary constant, no hash helper — and it is handed only what a
third party would have: the database, and the label string in the column. It
re-derives the leaf source, the order and the construction from the label by
splitting it on `/`, recomputes, and compares bytes.

    python3 scripts/f4-root-arithmetic.py --db <path> [--json]

🔴 Opens the database READ-ONLY, through the `file:///` absolute form. See
WO-F7(a): `file:` plus a relative or Windows path silently opens a DIFFERENT,
EMPTY database and every lookup then answers "not found" — a path bug wearing
the costume of the provenance failure it imitates.
"""
import argparse, hashlib, json, os, sqlite3, sys

def sha(b): return hashlib.sha256(b).digest()

def c_identity(leaves):
    if len(leaves) != 1: return None
    return leaves[0]

def c_hex_concat(leaves):
    lvl = list(leaves)
    while len(lvl) > 1:
        nxt = []
        for i in range(0, len(lvl), 2):
            if i + 1 < len(lvl):
                nxt.append(hashlib.sha256((lvl[i] + lvl[i+1]).encode('ascii')).hexdigest())
            else:
                nxt.append(lvl[i])
        lvl = nxt
    return lvl[0]

def c_sorted_pair(leaves):
    lvl = [bytes.fromhex(x) for x in leaves]
    while len(lvl) > 1:
        nxt = []
        for i in range(0, len(lvl), 2):
            if i + 1 < len(lvl):
                a, b = lvl[i], lvl[i+1]
                nxt.append(sha(a + b if a <= b else b + a))
            else:
                nxt.append(lvl[i])
        lvl = nxt
    return lvl[0].hex()

def c_rfc6962(leaves):
    bs = [bytes.fromhex(x) for x in leaves]
    def mth(ls):
        if not ls: return sha(b'')
        if len(ls) == 1: return sha(b'\x00' + ls[0])
        k = 1
        while k * 2 < len(ls): k *= 2
        return sha(b'\x01' + mth(ls[:k]) + mth(ls[k:]))
    return mth(bs).hex()

CONS = {
    'identity-single-leaf': c_identity,
    'hex-concat-v1': c_hex_concat,
    'sorted-pair-v1': c_sorted_pair,
    'rfc6962-v1': c_rfc6962,
}
TERMINAL = ('unreproducible', 'no-leaves')

def verify(algorithm, stored_root, leaves):
    """leaves: list of (run_sequence, leaf_hash, content_hash)."""
    if algorithm is None or algorithm == '':
        return ('refused', 'algorithm_absent', None)
    if algorithm == 'unreproducible':
        return ('refused', 'algorithm_unreproducible', None)
    if algorithm == 'no-leaves':
        return ('refused', 'algorithm_no_leaves', None)
    parts = algorithm.split('/')
    if len(parts) != 3:
        return ('refused', 'algorithm_unknown', None)
    cons, src, order = parts
    if cons not in CONS or src not in ('leaf_hash', 'content_hash') or order not in ('asc', 'desc'):
        return ('refused', 'algorithm_unknown', None)
    if cons == 'identity-single-leaf' and order != 'asc':
        return ('refused', 'algorithm_unknown', None)
    if not (isinstance(stored_root, str) and len(stored_root) == 64):
        return ('refused', 'stored_root_malformed', None)
    if not leaves:
        return ('refused', 'no_leaves_present', None)
    if cons == 'identity-single-leaf' and len(leaves) != 1:
        return ('refused', 'leaf_count_mismatch', None)
    rows = sorted(leaves, key=lambda r: r[0])
    if order == 'desc':
        rows = list(reversed(rows))
    idx = 1 if src == 'leaf_hash' else 2
    vals = [r[idx] for r in rows]
    if any(v is None or len(v) != 64 for v in vals):
        return ('refused', 'leaf_source_unavailable', None)
    got = CONS[cons](vals)
    if got != stored_root:
        return ('refused', 'root_mismatch', got)
    return ('verified', None, got)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    path = os.path.realpath(a.db)
    con = sqlite3.connect('file://' + path + '?mode=ro', uri=True)
    cols = [r[1] for r in con.execute('PRAGMA table_info(locked_projects)')]
    if 'merkle_algorithm' not in cols:
        print('merkle_algorithm column ABSENT', file=sys.stderr)
        sys.exit(4)
    out = []
    for pid, root, alg in con.execute(
            'SELECT project_id, merkle_root, merkle_algorithm FROM locked_projects ORDER BY locked_at'):
        leaves = list(con.execute(
            'SELECT run_sequence, leaf_hash, content_hash FROM witnesses WHERE project_id=?', (pid,)))
        outcome, reason, computed = verify(alg, root, leaves)
        out.append({'project_id': pid, 'algorithm': alg, 'outcome': outcome,
                    'reason': reason, 'computed': computed, 'leaves': len(leaves)})
    v = sum(1 for r in out if r['outcome'] == 'verified')
    if a.json:
        print(json.dumps({'db': path, 'verified': v, 'refused': len(out) - v, 'rows': out}, indent=2))
    else:
        for r in out:
            print(f"  {r['project_id']:44}{str(r['algorithm']):38}{r['outcome']}"
                  f"{' ' + r['reason'] if r['reason'] else ''}")
        print(f"\nverified {v}   refused {len(out)-v}   of {len(out)}")

main()
