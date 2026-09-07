#!/usr/bin/env bash
# WO-S1 — close the two server/SDK gaps the Blender client hit.
# Runs in PARALLEL with the B-series (different repo). Detached.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; SB="/mnt/corpus/scruple-blender-l2"
STATUS="$REPO/docs/canon/blender-l2/STATUS.md"
export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="$SB/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export TMPDIR="$SB/tmp"
note(){ printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }
note "START  WO-S1 (parallel, server+SDK)"
t0=$SECONDS
if timeout 7200 claude -p "Execute WO-S1 in /data/scruple-web/docs/wo/2026-09-07-blender-l2.md — READ IT FIRST (it is the last section).

Scope is /data/scruple-web ONLY. 🔴 Do NOT touch /data/scruple-blender — another
work order is editing it concurrently.

Sandbox — the only endpoints you may use:
  app        $SCRUPLE_APP_URL   (scratch; hot-reloads your changes)
  witness    $WITNESS_SERVER_URL  (scratch, already holds signed leaves)
  surrogate  $SCRUPLE_CVM_SURROGATE
🔴 NEVER contact 127.0.0.1:5799 (PRODUCTION witness, a live audit log).
🔴 NEVER contact :3001 (scruple.stooges.ai, live out of this same tree). Your
   edits DO reach it, so keep every change additive and do not break a caller.

Both gaps were verified by hand before this WO was written; you are closing
them, not re-litigating whether they are real.

Verify by side effect, not by report. Pair every must-fire check with a
must-NOT-fire control. Run the existing suites (npm run test:v2, the
scruple-host-sdk pytest suite) and do not leave them red. Prefer Bash over
Read/Edit/Write. Commit; do not push." \
      --permission-mode bypassPermissions >> "$SB/WO-S1.log" 2>&1; then
  note "DONE   WO-S1  ($(( (SECONDS-t0)/60 ))m)"
else
  note "FAILED WO-S1 (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/WO-S1.log"
fi
