#!/usr/bin/env bash
# WO-D6 gate. One command, non-zero if anything misbehaves.
#
#   stage 0  the sandbox — a key and a baseline over app/comfy's OWN source,
#            which now includes app/comfy/hostAdapter.ts
#   stage 1  the CONTROL, RED BEFORE THE CHANGE AND GREEN AFTER. A git
#            worktree of the server repo at the commit before this work order,
#            asked the same two questions as the tree after it.
#   stage 2  the STATIC control: the adapter contract is imported, not
#            reimplemented — no local sink, no local canonicalization
#   stage 3  the server's own suite for the hook (registration, composition,
#            rule 7, the route)
#   the gate LEVEL 2 — a fake host declares itself, announces one generation,
#            and its semantics reach the leaf
#   stage 5  LEVEL 1 — the same gate with nobody registered, and the leaf SAYS
#            it is blind. The work order's control, asserted positively.
#   stage 6  the three states, read FROM THE SHELL out of the app database:
#            blind ≠ declined ≠ supplied, from three real runs
#   stage 7  the audit sweeps — every mutation reddens exactly what it targets
#   control  a passing run must NOT satisfy --expect-fail
#
# Nothing here reads a log line and nothing reads a pixel (docs/DESIGN.md:
# llvmpipe returns a blank frame).
set -uo pipefail
cd "$(dirname "$0")/.."
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
export SCRUPLE_APP_URL="$APP_URL"
export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
# ── schema preflight ────────────────────────────────────────────────────────
# WO-E4 finding E4-0: when the database is behind the tree, a gate fails as
# ASSERTION ERRORS and says nothing about the cause — WO-D6 was silently red for
# over an hour that way, reporting `no iteration row` eleven times. Exit 3 below
# means MIGRATIONS PENDING and is not a test failure. On a fresh clone every
# migration is pending, so this is the difference between a first run that
# explains itself and one that looks like a platform bug.
node vendor/scruple-web/scripts/preflight-schema.mjs --apply || {
  echo "GATE ABORTED: schema preflight failed — this is NOT a test failure."; exit 3; }
export SCRUPLE_WITNESS_DB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
export SCRUPLE_BDK_ALLOW_DEV="${SCRUPLE_BDK_ALLOW_DEV:-1}"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
BEFORE_TREE="${D6_BEFORE_TREE:-/tmp/d6-before}"
rc=0

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }
newest(){ ls -dt .run/d2/$1-* 2>/dev/null | head -1; }

stage "stage 0 — the sandbox, baselined over app/comfy/"
bash scripts/tsx.sh scripts/d3-sandbox.ts --surface app/comfy || { echo "   sandbox failed"; exit 2; }

stage "stage 1 — THE CONTROL, RED BEFORE THE CHANGE"
# A worktree of the server repo at the commit BEFORE this work order, asked the
# same two questions as the tree after it. Both answers are returned values;
# neither is a log line.
if [ ! -d "$BEFORE_TREE" ]; then
  echo "   (materialising the pre-change worktree at $BEFORE_TREE)"
  # ⚑ RESOLVED FROM THE CHANGE, NEVER FROM HEAD. WO-D5's gate pinned its own
  # "before" to HEAD, which was the pre-change tree only while that work order
  # was uncommitted — it passed once and went red forever afterwards on a
  # repository that had not regressed. The parent of the commit that first
  # ADDED lib/capture/hostRegistry.ts cannot move, so this comparison keeps
  # meaning the same thing however many work orders land after it.
  D6_COMMIT=$(git -C "$WEB" log --diff-filter=A --format=%H -- lib/capture/hostRegistry.ts | tail -1)
  BASE="${D6_COMMIT:+$D6_COMMIT^}"; BASE="${BASE:-HEAD}"
  echo "   (the before-tree is $BASE)"
  git -C "$WEB" worktree add -f "$BEFORE_TREE" "$BASE" >/dev/null 2>&1
  ln -sfn "$WEB/node_modules" "$BEFORE_TREE/node_modules"
fi
BEFORE=$(SCRUPLE_WEB_ROOT="$BEFORE_TREE" bash scripts/tsx.sh scripts/d6-probe.mjs "$BEFORE_TREE" 2>/dev/null)
AFTER=$(bash scripts/tsx.sh scripts/d6-probe.mjs "$WEB" 2>/dev/null)
python3 - "$BEFORE" "$AFTER" <<'PY' || rc=1
import json, sys
b, a = json.loads(sys.argv[1]), json.loads(sys.argv[2])
ok = True
print(f"   {'':<52}{'BEFORE':<26}AFTER")
print(f"   {'a Level-1 leaf declares its level':<52}"
      f"{str(b['q1']['inSubmission']):<26}{a['q1']['inSubmission']}")
print(f"   {'...and it is in the MAC preimage':<52}"
      f"{str(b['q1']['inPreimage']):<26}{a['q1']['inPreimage']}")
print(f"   {'a forged Level-2 claim is refused':<52}"
      f"{'accepted' if b['q2']['accepted'] else b['q2']['code']:<26}"
      f"{'accepted' if a['q2']['accepted'] else a['q2']['code']}")
if b['q1']['declaresItsLevel']:
    print('   FAIL  the pre-change tree already declared a level — the control is vacuous'); ok = False
if not b['q2']['accepted']:
    print('   FAIL  the pre-change tree already refused the forged claim'); ok = False
if a['q1']['inSubmission'] != 'blind' or a['q1']['inPreimage'] != 'blind':
    print('   FAIL  the post-change tree does not default a Level-1 leaf to `blind`'); ok = False
if a['q2']['accepted'] or a['q2']['code'] != 'host_semantics_refused':
    print('   FAIL  the post-change tree accepts a Level-2 claim with nobody behind it'); ok = False
print('   PASS  both controls were RED before this change and are GREEN after' if ok else '   NOT PASSED')
sys.exit(0 if ok else 1)
PY

stage "stage 2 — STATIC control: the contract is imported, never reimplemented"
# `hostAdapterSink` composes the adapter with the Submitter, and the SDK owns
# that composition on purpose: a host that wrote its own sink could swallow an
# observation, decide a MIME or spend a ratchet counter. What this repo
# supplies is `semanticsFor`, a pure function. Checked where it is cheap.
if grep -q "hostAdapterSink" app/comfy/gate.ts && grep -q "hostAdapterSink" app/comfy/sdk.ts; then
  echo "   PASS  the composition comes from lib/capture/hostRegistry.ts"
else
  echo "   FAIL  the gate does not use the SDK's adapter composition"; rc=1
fi
hits=$(grep -nE "canonicalize\(|createHash\(.*host_evidence|JSON\.stringify\(.*evidence.*digest" app/comfy/*.ts \
        | grep -vE "^[^:]+:[0-9]+: *(//|\*)" || true)
if [ -n "$hits" ]; then
  echo "   FAIL — app/comfy canonicalises host evidence itself:"; echo "$hits"; rc=1
else
  echo "   PASS  no local canonicalization of host evidence anywhere in app/comfy/"
fi
if grep -q "registerHost" app/comfy/hostAdapter.ts; then
  echo "   PASS  a host declaration is validated by the SDK's registerHost(), not by us"
else
  echo "   FAIL  the declaration is not validated through registerHost()"; rc=1
fi

stage "stage 3 — the server's own suite for the hook"
( cd "$WEB" && SCRUPLE_DB_PATH="$(mktemp -d)/d6.db" \
    node --import tsx --test test/v2/host-hook.test.ts 2>&1 | tail -6 ) || rc=1

stage "the gate — LEVEL 2: a fake host's semantics reach the leaf"
echo "\$ node scripts/desktop-run.mjs host-adapter"
node scripts/desktop-run.mjs host-adapter --url "$APP_URL" || rc=1
L2="$(newest clean)"

stage "stage 5 — LEVEL 1: the same gate with nobody registered, and it SAYS so"
echo "\$ node scripts/desktop-run.mjs host-blind"
node scripts/desktop-run.mjs host-blind --url "$APP_URL" || rc=1
L1="$(newest clean)"

stage "stage 6 — blind ≠ declined ≠ supplied, read FROM THE SHELL"
# Independent of node, of the app, of the gate and of the sidecar: sqlite3
# reads three leaves written by three real runs, and bash compares them. The
# middle row is the one a two-valued design would have lost.
node scripts/desktop-run.mjs host-adapter --url "$APP_URL" --break no-announcement --expect-fail >/dev/null 2>&1
DEC="$(newest break-no-announcement)"
read_hash(){ python3 -c "
import json,sys
try:
    r=json.load(open('$1/result.json'))
    print(r['steps']['gen']['value']['images'][0]['sha256'])
except Exception: print('')
"; }
printf '   %-12s %-10s %-14s %-16s %s\n' RUN SEMANTICS HOST ADAPTER "EVIDENCE?"
seen=""
for pair in "supplied:$L2" "blind:$L1" "declined:$DEC"; do
  want="${pair%%:*}"; dir="${pair#*:}"
  H="$(read_hash "$dir")"
  if [ -z "$H" ]; then echo "   FAIL  no artifact hash in $dir"; rc=1; continue; fi
  ROW=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
    "SELECT COALESCE(host_semantics,'(null)') || '|' || COALESCE(host,'(null)') || '|' ||
            COALESCE(host_adapter,'(null)') || '|' ||
            CASE WHEN host_evidence IS NULL THEN 'no' ELSE 'yes' END
       FROM iterations WHERE output_hash='$H' ORDER BY rowid DESC LIMIT 1;")
  IFS='|' read -r sem host adap ev <<<"$ROW"
  printf '   %-12s %-10s %-14s %-16s %s\n' "$want" "$sem" "$host" "$adap" "$ev"
  [ "$sem" = "$want" ] || { echo "   FAIL  expected host_semantics=$want, the leaf says $sem"; rc=1; }
  case "$seen" in *"$sem"*) echo "   FAIL  $sem appeared twice — the three states are not distinct"; rc=1;; esac
  seen="$seen $sem"
done
if [ $rc -eq 0 ]; then
  echo "   PASS  three leaves, three states. 'declined' names the host and carries no document;"
  echo "         'blind' names nobody. An integration that is not working does not read as one"
  echo "         that was never done."
fi

stage "stage 7 — the audit sweeps"
node scripts/desktop-run.mjs host-adapter --url "$APP_URL" --audit || rc=1
node scripts/desktop-run.mjs host-blind   --url "$APP_URL" --audit || rc=1

stage "control — a clean run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs host-blind --url "$APP_URL" --expect-fail >/dev/null 2>&1; then
  echo "   a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-D6 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED, both levels observable, every control fired' || echo 'NOT PASSED')"
exit $rc
