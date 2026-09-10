#!/usr/bin/env bash
# WO-F4 — merkle_algorithm ON THE SNAPSHOT COPY, AND A VERIFIER THAT REFUSES.
#
#   npm run f4      (bash scripts/f4-gate.sh)
#
# `docs/canon/MERKLE_CUTOVER_RUNBOOK.md` steps 1–3. The cutover puts every NEW
# root on RFC 6962. Of the 31 roots already stored in the production witness,
# 15 reproduce today and NONE of them reproduces under RFC 6962 — and two of
# the 15 are anchored on Arweave and Ravencoin, where the commitment cannot be
# withdrawn. A bare cutover leaves those two public anchors committing to a
# value no code in the estate can produce, which invites the reader to conclude
# the root was altered.
#
# So: record the algorithm that produced each stored root BEFORE changing what
# the code computes, and teach the verifier to dispatch on it.
#
# THE GATE: all 15 reproducible roots verify THROUGH THE COLUMN, and the 16
# that never reproduced are labelled `unreproducible` or `no-leaves` and are
# REFUSED rather than guessed at.
#
# THE CONTROLS:
#   (a) a row whose algorithm is NULL is REFUSED — not silently tried as RFC
#       6962. Shown two ways: the refusal carries no computed root at all, and
#       the same row asked AS IF it were RFC 6962 produces a root that is not
#       the stored one. That second number is what "default to the canonical
#       construction" would have answered for an Arweave-anchored project.
#   (b) the two anchored rows (projects `30` and `32`) verify — from the leaves
#       in the database, under the algorithm the column records, with their
#       Arweave and Ravencoin txids asserted present so the check has stakes.
#   (c) `puffjuly12-1783882341` is labelled `unreproducible` and does NOT
#       acquire a label that makes it look verified. Proved by SEARCH, not by
#       assertion: every label in the vocabulary is tried against it and none
#       verifies — and the same search, run against project `30`, finds one.
#       A search that never finds anything would make (c) vacuous.
#
# AND FOUR MORE THAT MUST NOT FIRE, because a column nothing depends on is
# decoration:
#   · the LEAF COLUMN is load-bearing — project 27's label with `content_hash`
#     substituted is refused `root_mismatch`.
#   · the ORDER is load-bearing — project 6, whose root depends on the order an
#     unordered SELECT happened to return, is refused under `asc`.
#   · the runbook's own short label `hex-concat-v1` is refused `algorithm_unknown`
#     rather than accepted with a guessed column.
#   · one flipped hex digit in one leaf moves project 30 from verified to
#     refused, while project 32 in the same tampered database still verifies.
#
# 🔴 RAILS. This gate contacts NOTHING. No port is opened, no server starts,
# `:5799` and `:3001` are not dialled and neither is the sandbox on `:5899`.
# `/opt/scruple-witness` is READ — mtime and md5 only, as a tripwire — and
# never written; both the backfill and the verifier REFUSE any path under
# `/opt` outright, which is demonstrated here rather than trusted. All work
# happens on the snapshot copy at
# `/mnt/corpus/scruple-council-impl/c7-rehearsal/witness-prod-copy.db` and on
# throwaway copies of its pristine byte-for-byte backup.
#
# 🔴 `CHECKPOINT_VECTORS_SETTLED` is not touched and step 4 (the five call
# sites) is NOT in this work order. Neither is the one-line call from
# `services/witness-server/server.js` — see docs/WO-F4.md for why that has to
# ride with the founder's deploy rather than land here.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
WEB="${SCRUPLE_WEB_REPO:-/data/scruple-web}"
REHEARSAL="${SCRUPLE_C7_REHEARSAL:-/mnt/corpus/scruple-council-impl/c7-rehearsal}"
COPY="$REHEARSAL/witness-prod-copy.db"
PRISTINE="$REHEARSAL/witness-prod-copy.pristine.db"
RUN="$REPO/.run/f4"; rm -rf "$RUN"; mkdir -p "$RUN"
WORK="$RUN/work.db"

# The tripwire the C7 rehearsal calibrated: the live witness database's mtime,
# recorded as legitimate on 2026-09-02 23:37:46. It is asserted before and
# after, so "nothing was written to production" is a measurement in this
# transcript and not a promise in a paragraph.
LIVE_DB=/opt/scruple-witness/witness.db
LIVE_DB_MTIME=1788392266
LIVE_SERVER=/opt/scruple-witness/server.js
PRISTINE_SHA=9ce5397781bb8c320f76a02d0d36c8e3656bdeac9e274a78131f9c9a996e0c29

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-58s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-58s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
differs(){ if [ "$2" != "$3" ]; then printf '   ok    %-58s %s != %s\n' "$1" "${2:0:16}" "${3:0:16}"; ok=$((ok+1));
           else printf '   FAIL  %-58s both %s\n' "$1" "${2:0:16}"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-58s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }

# 🔴 WO-F7(a): `file:` + anything but an absolute POSIX path silently opens a
# DIFFERENT, EMPTY database and every lookup answers "not found" — a path bug
# wearing the costume of the provenance failure it imitates. `file:///` +
# forward slashes is the form that is actually read-only and actually resolves.
q(){ sqlite3 "file://$1?mode=ro" -batch "$2" 2>/dev/null; }

VERIFY="node $WEB/scripts/merkle-algorithm-verify.mjs"
BACKFILL="node $WEB/scripts/merkle-algorithm-backfill.mjs"
PYVER="python3 $REPO/scripts/f4-root-arithmetic.py"

printf '\n╔══════════════════════════════════════════════════════════════════════════╗\n'
printf   '║  WO-F4 — merkle_algorithm on the snapshot, and a verifier that refuses    ║\n'
printf   '╚══════════════════════════════════════════════════════════════════════════╝\n'

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 0 — the rails, measured"
# ═══════════════════════════════════════════════════════════════════════════
check "RAIL-live-witness-db-mtime-unchanged" "$LIVE_DB_MTIME" "$(stat -c %Y "$LIVE_DB" 2>/dev/null || echo unreadable)"
DEPLOYED_MD5=$(md5sum "$LIVE_SERVER" 2>/dev/null | cut -d' ' -f1)
REPO_MD5=$(md5sum "$WEB/services/witness-server/server.js" | cut -d' ' -f1)
# merkle-conformance.mjs marks the deployed-witness row UNKNOWN if these two
# differ, and test/v2/merkle-conformance.test.ts asserts they do not. WO-F4
# therefore does NOT edit server.js.
check "RAIL-repo-witness-server-still-byte-identical" "$DEPLOYED_MD5" "$REPO_MD5"
check "RAIL-pristine-snapshot-digest" "$PRISTINE_SHA" "$(sha256sum "$PRISTINE" | cut -d' ' -f1)"

$BACKFILL --db "$LIVE_DB" --apply >"$RUN/rail-backfill-opt.txt" 2>&1; rc=$?
check "RAIL-backfill-refuses-a-path-under-/opt" "3" "$rc"
$VERIFY --db "$LIVE_DB" --all >"$RUN/rail-verify-opt.txt" 2>&1; rc=$?
check "RAIL-verifier-refuses-a-path-under-/opt" "3" "$rc"

# The read-only URI is read-only in fact, not by convention.
pushd "$RUN" >/dev/null
sqlite3 "file://$PRISTINE?mode=ro" "CREATE TABLE rail_probe(x)" >/dev/null 2>&1; rc=$?
check "RAIL-mode=ro-uri-refuses-a-write" "1" "$((rc==0?0:1))"
check "RAIL-no-stray-'=ro'-file-created" "absent" "$([ -e '=ro' ] && echo PRESENT || echo absent)"
popd >/dev/null
check "RAIL-pristine-unchanged-after-write-attempt" "$PRISTINE_SHA" "$(sha256sum "$PRISTINE" | cut -d' ' -f1)"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 1 — RED BEFORE: without the column, nothing can be verified"
# ═══════════════════════════════════════════════════════════════════════════
cp "$PRISTINE" "$WORK"; chmod 644 "$WORK"
check "RED-column-absent-on-a-fresh-copy" "absent" \
  "$(q "$WORK" "SELECT CASE WHEN COUNT(*)>0 THEN 'present' ELSE 'absent' END FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"
check "RED-locked-rows-present" "31" "$(q "$WORK" 'SELECT COUNT(*) FROM locked_projects')"
check "RED-witness-rows-present" "188" "$(q "$WORK" 'SELECT COUNT(*) FROM witnesses')"

$PYVER --db "$WORK" >"$RUN/red-python.txt" 2>&1; rc=$?
check "RED-independent-verifier-cannot-run-without-the-column" "4" "$rc"

$VERIFY --db "$WORK" --all --json >"$RUN/red-all.json" 2>&1
check "RED-all-31-rows-refused" "0" "$(python3 -c "import json;print(json.load(open('$RUN/red-all.json'))['verified'])")"
check "RED-every-refusal-reads-algorithm_absent" "31" \
  "$(python3 -c "import json;d=json.load(open('$RUN/red-all.json'));print(sum(1 for r in d['rows'] if r['reason']=='algorithm_absent'))")"
$VERIFY --db "$WORK" --project 30 >"$RUN/red-30.txt" 2>&1
check "RED-anchored-project-30-refused" "1" "$(grep -c 'refused algorithm_absent' "$RUN/red-30.txt")"
$VERIFY --db "$WORK" --project 32 >"$RUN/red-32.txt" 2>&1
check "RED-anchored-project-32-refused" "1" "$(grep -c 'refused algorithm_absent' "$RUN/red-32.txt")"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 2 — step 1: the column, additive and nullable"
# ═══════════════════════════════════════════════════════════════════════════
# The pre-existing column list, taken from the PRISTINE so the comparison is
# not defined by the thing it is checking.
LP_COLS=$(q "$PRISTINE" "SELECT GROUP_CONCAT(name) FROM pragma_table_info('locked_projects')")
W_COLS=$(q "$PRISTINE" "SELECT GROUP_CONCAT(name) FROM pragma_table_info('witnesses')")
LP_BEFORE=$(q "$PRISTINE" "SELECT $LP_COLS FROM locked_projects ORDER BY project_id" | sha256sum | cut -d' ' -f1)
W_BEFORE=$(q "$PRISTINE" "SELECT $W_COLS FROM witnesses ORDER BY id" | sha256sum | cut -d' ' -f1)

$BACKFILL --db "$WORK" --apply >"$RUN/backfill-1.txt" 2>&1; rc=$?
check "STEP1-backfill-exits-clean" "0" "$rc"
check "STEP1-column-added" "present" \
  "$(q "$WORK" "SELECT CASE WHEN COUNT(*)>0 THEN 'present' ELSE 'absent' END FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"
check "STEP1-column-is-nullable" "0" "$(q "$WORK" "SELECT [notnull] FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"
check "STEP1-column-has-no-default" "" "$(q "$WORK" "SELECT COALESCE(dflt_value,'') FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"
check "STEP1-column-type-TEXT" "TEXT" "$(q "$WORK" "SELECT type FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"

LP_AFTER=$(q "$WORK" "SELECT $LP_COLS FROM locked_projects ORDER BY project_id" | sha256sum | cut -d' ' -f1)
W_AFTER=$(q "$WORK" "SELECT $W_COLS FROM witnesses ORDER BY id" | sha256sum | cut -d' ' -f1)
check "STEP1-locked_projects-pre-existing-columns-unmoved" "$LP_BEFORE" "$LP_AFTER"
check "STEP1-witnesses-table-unmoved" "$W_BEFORE" "$W_AFTER"

LABELS_1=$(q "$WORK" "SELECT project_id||'='||COALESCE(merkle_algorithm,'NULL') FROM locked_projects ORDER BY project_id" | sha256sum | cut -d' ' -f1)
$BACKFILL --db "$WORK" --apply >"$RUN/backfill-2.txt" 2>&1; rc=$?
check "STEP1-second-apply-exits-clean" "0" "$rc"
check "STEP1-second-apply-adds-no-column" "1" "$(grep -c 'column        already present' "$RUN/backfill-2.txt")"
LABELS_2=$(q "$WORK" "SELECT project_id||'='||COALESCE(merkle_algorithm,'NULL') FROM locked_projects ORDER BY project_id" | sha256sum | cut -d' ' -f1)
check "STEP1-backfill-is-idempotent" "$LABELS_1" "$LABELS_2"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 3 — THE GATE: 15 verify through the column, 16 are refused"
# ═══════════════════════════════════════════════════════════════════════════
$VERIFY --db "$WORK" --all --json >"$RUN/green-all.json" 2>&1
G(){ python3 -c "import json;d=json.load(open('$RUN/green-all.json'));print($1)"; }
check "GATE-15-roots-verify-through-the-column" "15" "$(G "d['verified']")"
check "GATE-16-roots-refused"                   "16" "$(G "d['refused']")"
check "GATE-no-row-left-NULL"                    "0" "$(G "sum(1 for r in d['rows'] if r['algorithm'] is None)")"
check "GATE-13-labelled-unreproducible"         "13" "$(G "sum(1 for r in d['rows'] if r['algorithm']=='unreproducible')")"
check "GATE-3-labelled-no-leaves"                "3" "$(G "sum(1 for r in d['rows'] if r['algorithm']=='no-leaves')")"
check "GATE-every-refusal-is-one-of-those-two"  "16" "$(G "sum(1 for r in d['rows'] if r['outcome']=='refused' and r['algorithm'] in ('unreproducible','no-leaves'))")"
check "GATE-no-refusal-is-a-root_mismatch"       "0" "$(G "sum(1 for r in d['rows'] if r['reason']=='root_mismatch')")"

# The second implementation. Shares no code with the first: Python, no import,
# handed only the database and the label string.
$PYVER --db "$WORK" --json >"$RUN/green-python.json" 2>&1; rc=$?
check "GATE-independent-python-verifier-runs" "0" "$rc"
check "GATE-independent-python-verifies-15" "15" \
  "$(python3 -c "import json;print(json.load(open('$RUN/green-python.json'))['verified'])")"
check "GATE-two-implementations-agree-on-all-31-rows" "31" "$(python3 - <<'PY'
import json
a=json.load(open('.run/f4/green-all.json'))['rows']
b=json.load(open('.run/f4/green-python.json'))['rows']
ka={r['project_id']:(r['algorithm'],r['outcome'],r['reason']) for r in a}
kb={r['project_id']:(r['algorithm'],r['outcome'],r['reason']) for r in b}
print(sum(1 for k in ka if k in kb and ka[k]==kb[k]))
PY
)"

# ── the two corrections this sweep makes to the rehearsal's own §1 ─────────
# F4-1: the leaf COLUMN is not in the runbook's vocabulary, and the estate
# needs both — so a label naming only a construction cannot be dispatched on.
check "GATE-roots-whose-leaves-are-leaf_hash"    "7" "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE '%/leaf_hash/%'")"
check "GATE-roots-whose-leaves-are-content_hash" "8" "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE '%/content_hash/%'")"
# F4-1 again: 10 of the 15 are one-leaf trees, where identity, sorted-pair and
# hex-concat are the SAME function. The runbook calls 9 of them `sorted-pair-v1`.
check "GATE-one-leaf-trees-among-the-15" "10" \
  "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE 'identity-single-leaf/%'")"
check "GATE-multi-leaf-trees-among-the-15" "5" \
  "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE 'hex-concat-v1/%'")"
check "GATE-no-stored-root-is-sorted-pair-at-n-greater-than-1" "0" \
  "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE 'sorted-pair-v1/%'")"
check "GATE-no-stored-root-is-RFC-6962" "0" \
  "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE merkle_algorithm LIKE 'rfc6962-v1/%'")"
# F4-2: §1 says "12 of them have a witnessed_count that disagrees" and then
# lists 13 project ids. 13 rows disagree; 12 of those are unreproducible; the
# 13th is project 27, whose count disagrees and whose root reproduces anyway.
DISAGREE="SELECT COUNT(*) FROM locked_projects lp WHERE lp.witnessed_count <> (SELECT COUNT(*) FROM witnesses w WHERE w.project_id=lp.project_id)"
check "GATE-rows-whose-witnessed_count-disagrees" "13" "$(q "$WORK" "$DISAGREE")"
check "GATE-of-those-unreproducible"              "12" "$(q "$WORK" "$DISAGREE AND lp.merkle_algorithm='unreproducible'")"
check "GATE-of-those-reproducible-is-project-27"  "27" "$(q "$WORK" "SELECT lp.project_id FROM locked_projects lp WHERE lp.witnessed_count <> (SELECT COUNT(*) FROM witnesses w WHERE w.project_id=lp.project_id) AND lp.merkle_algorithm <> 'unreproducible'")"

printf '\n   the estate, as labelled:\n'
q "$WORK" "SELECT '     '||printf('%-4d',COUNT(*))||merkle_algorithm FROM locked_projects GROUP BY merkle_algorithm ORDER BY COUNT(*) DESC"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 4 — control (a): NULL is refused, never tried as RFC 6962"
# ═══════════════════════════════════════════════════════════════════════════
# 🔴 `.backup`, not `cp`. The snapshot is a WAL database, so a plain file copy
# can leave a committed label behind in `<db>-wal` and produce a database that
# has the column and NULL in every row. That is not a hypothetical: the first
# run of this gate did exactly that, and stages 4 and 7 went red reading
# `algorithm_absent` off rows that had been labelled two stages earlier.
NULLDB="$RUN/null-30.db"; sqlite3 "$WORK" ".backup '$NULLDB'"
sqlite3 "$NULLDB" "UPDATE locked_projects SET merkle_algorithm=NULL WHERE project_id='30'" 2>/dev/null
check "CTRL-a-row-30-is-now-NULL" "1" "$(q "$NULLDB" "SELECT COUNT(*) FROM locked_projects WHERE project_id='30' AND merkle_algorithm IS NULL")"
$VERIFY --db "$NULLDB" --project 30 --json >"$RUN/ctrl-a.json" 2>&1; rc=$?
check "CTRL-a-NULL-row-is-refused" "1" "$rc"
A(){ python3 -c "import json;d=json.load(open('$RUN/ctrl-a.json'));print($1)"; }
check "CTRL-a-reason-is-algorithm_absent" "algorithm_absent" "$(A "d['reason']")"
# The evidence that NOTHING was attempted: a refusal that had tried a
# construction would be carrying its answer.
check "CTRL-a-refusal-carries-no-computed-root" "None" "$(A "d['computed']")"
# And this is what "silently try RFC 6962" would have answered for an
# Arweave-anchored project.
$VERIFY --db "$WORK" --project 30 --algorithm rfc6962-v1/content_hash/asc --json >"$RUN/ctrl-a-rfc.json" 2>&1
R(){ python3 -c "import json;d=json.load(open('$RUN/ctrl-a-rfc.json'));print($1)"; }
check "CTRL-a-project-30-under-RFC-6962-is-refused" "root_mismatch" "$(R "d['reason']")"
differs "CTRL-a-RFC-root-is-not-the-anchored-root" "$(R "d['computed']")" "$(q "$WORK" "SELECT merkle_root FROM locked_projects WHERE project_id='30'")"
check "CTRL-a-and-the-other-30-rows-still-verify" "14" \
  "$(python3 -c "
import json,subprocess
o=subprocess.run(['node','$WEB/scripts/merkle-algorithm-verify.mjs','--db','$NULLDB','--all','--json'],capture_output=True,text=True).stdout
print(json.loads(o)['verified'])")"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 5 — control (b): the two anchored rows, which are why this exists"
# ═══════════════════════════════════════════════════════════════════════════
for P in 30 32; do
  check "CTRL-b-project-$P-has-an-arweave-txid" "1" "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE project_id='$P' AND arweave_txid IS NOT NULL")"
  check "CTRL-b-project-$P-has-a-ravencoin-txid" "1" "$(q "$WORK" "SELECT COUNT(*) FROM locked_projects WHERE project_id='$P' AND rvn_txid IS NOT NULL")"
  $VERIFY --db "$WORK" --project "$P" --json >"$RUN/ctrl-b-$P.json" 2>&1; rc=$?
  check "CTRL-b-project-$P-verifies-through-the-column" "0" "$rc"
  check "CTRL-b-project-$P-algorithm-recorded" "hex-concat-v1/content_hash/asc" \
    "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-b-$P.json'))['algorithm'])")"
  check "CTRL-b-project-$P-computed-root-equals-the-anchored-root" \
    "$(q "$WORK" "SELECT merkle_root FROM locked_projects WHERE project_id='$P'")" \
    "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-b-$P.json'))['computed'])")"
done

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 6 — control (c): puffjuly12 stays unreproducible, by search"
# ═══════════════════════════════════════════════════════════════════════════
PUFF=puffjuly12-1783882341
check "CTRL-c-puffjuly12-label" "unreproducible" "$(q "$WORK" "SELECT merkle_algorithm FROM locked_projects WHERE project_id='$PUFF'")"
$VERIFY --db "$WORK" --project "$PUFF" --json >"$RUN/ctrl-c.json" 2>&1; rc=$?
check "CTRL-c-puffjuly12-is-refused" "1" "$rc"
check "CTRL-c-puffjuly12-reason" "algorithm_unreproducible" \
  "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-c.json'))['reason'])")"
check "CTRL-c-puffjuly12-has-its-5-leaves-and-a-count-that-agrees" "5|5" \
  "$(q "$WORK" "SELECT witnessed_count||'|'||(SELECT COUNT(*) FROM witnesses WHERE project_id='$PUFF') FROM locked_projects WHERE project_id='$PUFF'")"
$VERIFY --db "$WORK" --exhaust "$PUFF" --json >"$RUN/ctrl-c-exhaust.json" 2>&1; rc=$?
check "CTRL-c-no-label-in-the-vocabulary-verifies-it" "0" "$rc"
E(){ python3 -c "import json;d=json.load(open('$RUN/ctrl-c-exhaust.json'));print($1)"; }
check "CTRL-c-labels-tried" "14" "$(E "d['labels_tried']")"
check "CTRL-c-labels-that-verify" "0" "$(E "len(d['labels_that_verify'])")"
# The control ON the control. A search that never finds anything proves nothing.
$VERIFY --db "$WORK" --exhaust 30 --json >"$RUN/ctrl-c-exhaust-30.json" 2>&1; rc=$?
check "CTRL-c-the-same-search-DOES-find-project-30" "1" "$rc"
check "CTRL-c-and-finds-exactly-its-recorded-label" "hex-concat-v1/content_hash/asc" \
  "$(python3 -c "import json;print(','.join(json.load(open('$RUN/ctrl-c-exhaust-30.json'))['labels_that_verify']))")"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 7 — four controls that must NOT fire"
# ═══════════════════════════════════════════════════════════════════════════
# The leaf COLUMN is part of the computation. Project 27's root is over
# leaf_hash; project 25's is over content_hash; both are one-leaf trees. Swap
# the column and the answer must change.
$VERIFY --db "$WORK" --project 27 --algorithm identity-single-leaf/content_hash/asc --json >"$RUN/ctrl-col.json" 2>&1
check "CTRL-leaf-column-is-load-bearing" "root_mismatch" \
  "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-col.json'))['reason'])")"
check "CTRL-project-27-under-its-own-label-still-verifies" "0" \
  "$($VERIFY --db "$WORK" --project 27 >/dev/null 2>&1; echo $?)"

# The ORDER is part of the computation. Project 6's root depends on the order
# an unordered SELECT happened to return — the defect class the runbook names.
$VERIFY --db "$WORK" --project 6 --algorithm hex-concat-v1/content_hash/asc --json >"$RUN/ctrl-ord.json" 2>&1
check "CTRL-order-is-load-bearing" "root_mismatch" \
  "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-ord.json'))['reason'])")"
check "CTRL-project-6-recorded-as-desc" "hex-concat-v1/content_hash/desc" \
  "$(q "$WORK" "SELECT merkle_algorithm FROM locked_projects WHERE project_id='6'")"

# The runbook's own vocabulary names a construction and not a column. Accepting
# it would put the guess back in.
$VERIFY --db "$WORK" --project 30 --algorithm hex-concat-v1 --json >"$RUN/ctrl-short.json" 2>&1
check "CTRL-runbook-short-label-is-refused-as-unknown" "algorithm_unknown" \
  "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-short.json'))['reason'])")"

# One flipped hex digit in one leaf. The column must not make a bad root pass.
TAMPER="$RUN/tampered.db"; sqlite3 "$WORK" ".backup '$TAMPER'"
OLD=$(q "$TAMPER" "SELECT content_hash FROM witnesses WHERE project_id='30' ORDER BY run_sequence LIMIT 1")
NEW="$(python3 -c "s='$OLD';d='0' if s[0]!='0' else '1';print(d+s[1:])")"
sqlite3 "$TAMPER" "UPDATE witnesses SET content_hash='$NEW' WHERE project_id='30' AND content_hash='$OLD'" 2>/dev/null
differs "CTRL-tamper-one-hex-digit-moved" "$OLD" "$NEW"
$VERIFY --db "$TAMPER" --project 30 --json >"$RUN/ctrl-tamper.json" 2>&1; rc=$?
check "CTRL-tampered-project-30-is-refused" "1" "$rc"
check "CTRL-tampered-reason-is-root_mismatch" "root_mismatch" \
  "$(python3 -c "import json;print(json.load(open('$RUN/ctrl-tamper.json'))['reason'])")"
check "CTRL-tamper-control-project-32-still-verifies" "0" \
  "$($VERIFY --db "$TAMPER" --project 32 >/dev/null 2>&1; echo $?)"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 8 — the designated snapshot copy carries the column"
# ═══════════════════════════════════════════════════════════════════════════
$BACKFILL --db "$COPY" --apply >"$RUN/backfill-copy.txt" 2>&1; rc=$?
check "COPY-backfill-exits-clean" "0" "$rc"
check "COPY-column-present" "present" \
  "$(q "$COPY" "SELECT CASE WHEN COUNT(*)>0 THEN 'present' ELSE 'absent' END FROM pragma_table_info('locked_projects') WHERE name='merkle_algorithm'")"
$VERIFY --db "$COPY" --all --json >"$RUN/copy-all.json" 2>&1
check "COPY-15-verify" "15" "$(python3 -c "import json;print(json.load(open('$RUN/copy-all.json'))['verified'])")"
$PYVER --db "$COPY" --json >"$RUN/copy-python.json" 2>&1
check "COPY-independent-python-agrees" "15" \
  "$(python3 -c "import json;print(json.load(open('$RUN/copy-python.json'))['verified'])")"
check "COPY-no-uncheckpointed-wal-left-behind" "absent" "$([ -s "$COPY-wal" ] && echo PRESENT || echo absent)"
COPY_LABELS=$(q "$COPY" "SELECT project_id||'='||COALESCE(merkle_algorithm,'NULL') FROM locked_projects ORDER BY project_id" | sha256sum | cut -d' ' -f1)
check "COPY-labels-identical-to-the-work-copy" "$LABELS_1" "$COPY_LABELS"

# ═══════════════════════════════════════════════════════════════════════════
note "STAGE 9 — the suites, and the rails again"
# ═══════════════════════════════════════════════════════════════════════════
( cd "$WEB" && SCRUPLE_DB_PATH="$RUN/suite.db" node --import tsx --test test/v2/stored-root-algorithm.test.ts ) >"$RUN/suite-f4.txt" 2>&1
check "SUITE-stored-root-algorithm-fail-count" "0" "$(grep -m1 '^# fail' "$RUN/suite-f4.txt" | awk '{print $3}')"
check "SUITE-stored-root-algorithm-pass-count" "20" "$(grep -m1 '^# pass' "$RUN/suite-f4.txt" | awk '{print $3}')"
( cd "$WEB" && SCRUPLE_DB_PATH="$RUN/suite2.db" node --import tsx --test test/v2/merkle-conformance.test.ts ) >"$RUN/suite-c6.txt" 2>&1
check "SUITE-merkle-conformance-still-green" "0" "$(grep -m1 '^# fail' "$RUN/suite-c6.txt" | awk '{print $3}')"

check "RAIL-live-witness-db-mtime-still-unchanged" "$LIVE_DB_MTIME" "$(stat -c %Y "$LIVE_DB" 2>/dev/null || echo unreadable)"
check "RAIL-deployed-server-md5-still-unchanged" "$DEPLOYED_MD5" "$(md5sum "$LIVE_SERVER" 2>/dev/null | cut -d' ' -f1)"
check "RAIL-repo-witness-server-still-byte-identical-after" "$DEPLOYED_MD5" "$(md5sum "$WEB/services/witness-server/server.js" | cut -d' ' -f1)"
check "RAIL-pristine-snapshot-digest-unchanged" "$PRISTINE_SHA" "$(sha256sum "$PRISTINE" | cut -d' ' -f1)"

printf '\n──────────────────────────────────────────────────────────────────────────\n'
printf '  %d checks ok / %d FAIL / %d inconclusive\n' "$ok" "$fail" "$inconclusive"
printf '  artefacts: %s\n' "$RUN"
printf '──────────────────────────────────────────────────────────────────────────\n\n'
[ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]
