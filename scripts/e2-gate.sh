#!/usr/bin/env bash
# WO-E2 — `declared_uncaptured`, the absence set, with its scope on the leaf.
#
# WO-C5 built the machinery (`council-impl/WO-C5.md` §10) and stopped before
# the set itself because its scope rule was unsettled. Round 5 §3 put the
# question; line 369 answered it; `docs/canon/DECLARED_UNCAPTURED.md` is that
# answer made decidable and was committed BEFORE any of the code.
#
# THE PROBE IS ALWAYS A LEAF, NEVER A CONFIGURATION. Every stage drives the
# real `CaptureComponent` against a stub ComfyUI that reports artifacts in
# `/history`, and reads the answers off the leaves the component actually
# submitted. A component that was configured correctly and emitted nothing
# passes a config check and fails this.
#
# Stages:
#
#   1  RED, at the parent commit, in a worktree it builds and removes:
#      the same three sessions, and NO leaf carries a scope at all.
#      The gate must NOT be raised and BOTH controls must be ABSENT
#      rather than satisfied.                              MUST fire.
#   2  GREEN, at HEAD: the gate is raised, both controls hold, and
#      `complete` is shown to be reachable.                MUST fire.
#   3  The unit and route suite for this WO.               MUST NOT fail.
#   4  Migration 059's cross-column CHECKs, against a FRESH database, from
#      the shell — the third guard, exercised without the validator.
#
# ⚑ AN INCONCLUSIVE CONTROL IS SCORED INCONCLUSIVE. Stage 1 asserts the exact
# reason each control is red at the parent commit — "the field is absent" — so
# that "the control did not fire" cannot be confused with "the control fired".
#
# 🔴 Touches no server. No app, no witness, no surrogate: this WO is a
# component-and-route change and every stage runs in a temporary directory.
set -uo pipefail
cd "$(dirname "$0")/.."
WEB="$PWD"
PARENT_TREE="${E2_PARENT_TREE:-/data/scruple-web-e2-parent}"
PARENT_REV="${E2_PARENT_REV:-HEAD~1}"
RUN="$WEB/.run/e2"
mkdir -p "$RUN"

pass=0; fail=0
ok()   { echo "   PASS  $*"; pass=$((pass+1)); }
bad()  { echo "   FAIL  $*"; fail=$((fail+1)); }

echo "== WO-E2 gate =="
echo "   HEAD          $(git -C "$WEB" rev-parse --short HEAD)"
echo "   parent rev    $PARENT_REV -> $(git -C "$WEB" rev-parse --short "$PARENT_REV")"
echo

# ── STAGE 1 — the controls, RED, at the parent commit ────────────────────
echo "-- stage 1: the same three sessions against $PARENT_REV, in a worktree"
git -C "$WEB" worktree remove --force "$PARENT_TREE" >/dev/null 2>&1
if ! git -C "$WEB" worktree add --detach "$PARENT_TREE" "$PARENT_REV" >/dev/null 2>&1; then
  echo "!! could not create the worktree at $PARENT_TREE"; exit 2
fi
# node_modules is not in the tree; the parent's sources need the same ones.
ln -sfn "$WEB/node_modules" "$PARENT_TREE/node_modules"

E2_REPO="$PARENT_TREE" E2_ROOT="/tmp/woe2-parent" \
  node --import tsx "$WEB/scripts/run-e2.mjs" > "$RUN/01-controls-RED.txt" 2>&1
red_rc=$?
cp "$WEB/scripts/run-e2.mjs" "$RUN/run-e2.mjs"

if [ "$red_rc" -ne 0 ]; then
  ok "stage 1: the gate FAILS at the parent commit (exit $red_rc)"
else
  bad "stage 1: the gate PASSED at the parent commit — it is not measuring the change"
fi

# The REASON it is red must be that the field is absent, not that a session
# crashed. An inconclusive control is scored INCONCLUSIVE.
# Counted off the PER-LEAF lines only. The session summaries also print
# `scope=(ABSENT)`, and counting those would make the two numbers disagree for
# a reason that has nothing to do with the leaves.
absent=$(grep -cE '^        method=.* scope=\(ABSENT\)' "$RUN/01-controls-RED.txt")
leaves=$(grep -cE '^   # *[0-9]+ n=' "$RUN/01-controls-RED.txt")
if [ "$leaves" -gt 0 ] && [ "$absent" -eq "$leaves" ]; then
  ok "stage 1: all $leaves leaves carry NO scope — the controls are red because the field does not exist"
elif [ "$leaves" -eq 0 ]; then
  bad "stage 1: INCONCLUSIVE — no leaf was emitted at the parent commit at all"
else
  bad "stage 1: INCONCLUSIVE — $absent of $leaves leaves lack a scope; expected all of them"
fi

check_red() {
  local label="$1" line="$2"
  if grep -qF "$line" "$RUN/01-controls-RED.txt"; then
    ok "stage 1: $label is RED at the parent commit"
  else
    bad "stage 1: $label — expected and not found: $line"
  fi
}
check_red 'the GATE'  'GATE      — an uncaptured artifact is NAMED, with a scope   : NOT RAISED'
check_red 'CONTROL 1' 'CONTROL 1 — nothing uncaptured is an EMPTY SET THAT IS THERE : ABSENT or wrong — control fired'
check_red 'CONTROL 2' 'CONTROL 2 — untyped roots REFUSE to claim closure            : NOT refused — control fired'

if [ "${E2_KEEP_WORKTREE:-0}" = "1" ]; then
  echo "   worktree kept at $PARENT_TREE (E2_KEEP_WORKTREE=1)"
else
  rm -f "$PARENT_TREE/node_modules"
  git -C "$WEB" worktree remove --force "$PARENT_TREE" >/dev/null 2>&1
  echo "   worktree removed (E2_KEEP_WORKTREE=1 to keep it)"
fi
echo

# ── STAGE 2 — GREEN, at HEAD ─────────────────────────────────────────────
echo "-- stage 2: the same three sessions at HEAD"
E2_REPO="$WEB" E2_ROOT="/tmp/woe2" \
  node --import tsx "$WEB/scripts/run-e2.mjs" > "$RUN/03-live-GREEN.txt" 2>&1
green_rc=$?
if [ "$green_rc" -eq 0 ]; then
  ok "stage 2: the gate PASSES at HEAD"
else
  bad "stage 2: the gate FAILED at HEAD (exit $green_rc) — see $RUN/03-live-GREEN.txt"
fi
grep -E '^  (GATE|CONTROL|REACHABLE)' "$RUN/03-live-GREEN.txt" | sed 's/^/   /'
echo

# ── STAGE 3 — the suite ──────────────────────────────────────────────────
echo "-- stage 3: test/v2/declared-uncaptured.test.ts"
SCRUPLE_DB_PATH="$(mktemp -d)/e2.db" \
  node --import tsx --test test/v2/declared-uncaptured.test.ts > "$RUN/04-suite.txt" 2>&1
suite_rc=$?
tail -6 "$RUN/04-suite.txt" | sed 's/^/   /'
if [ "$suite_rc" -eq 0 ]; then ok "stage 3: the WO-E2 suite is green"; else bad "stage 3: the WO-E2 suite failed"; fi
echo

# ── STAGE 4 — migration 059's CHECKs, from the shell ─────────────────────
echo "-- stage 4: migration 059's cross-column CHECKs, on a fresh database"
DB="$(mktemp -d)/059.db"
SCRUPLE_DB_PATH="$DB" npx tsx scripts/migrate.ts > "$RUN/05-migration.txt" 2>&1
node scripts/e2-migration-checks.mjs "$DB" | tee -a "$RUN/05-migration.txt"
mig_rc=${PIPESTATUS[0]}
if [ "$mig_rc" -eq 0 ]; then ok "stage 4: all eight rows land as 059 says they must"; else bad "stage 4: a CHECK did not behave as written"; fi
echo

echo "== WO-E2 gate: $pass pass / $fail fail =="
echo "   artifacts in $RUN"
[ "$fail" -eq 0 ]
