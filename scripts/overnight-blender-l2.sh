#!/usr/bin/env bash
# Overnight: Scruple for Blender to the L2 floor.
#
# Runs DETACHED so it survives disconnect. Each WO is a headless `claude -p`
# run that WRITES CODE and COMMITS in /data/scruple-blender (local git, no
# push). WO specs: docs/wo/2026-09-07-blender-l2.md
#
# Launch: nohup setsid bash scripts/overnight-blender-l2.sh >/mnt/corpus/scruple-blender-l2/runner.log 2>&1 &
# Watch:  tail -f /data/scruple-web/docs/canon/blender-l2/STATUS.md

set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
ADDON="/data/scruple-blender"
SB="/mnt/corpus/scruple-blender-l2"
OUT="$REPO/docs/canon/blender-l2"
STATUS="$OUT/STATUS.md"
mkdir -p "$OUT" "$SB"

# ── Safety rails ──────────────────────────────────────────────────────
# :5799 is the PRODUCTION witness (a live audit log — a run on 2026-08-29
# wrote 9 real rows into it). :3001 is scruple.stooges.ai, live and
# unsupervised out of this same tree. Neither is ever a target.
export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="$SB/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1
export TMPDIR="$SB/tmp"; mkdir -p "$TMPDIR"
unset SCRUPLE_C2PA_VAULT_KEY_OCID 2>/dev/null || true

note() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }

# ── Sandbox: idempotent bring-up, each verified by side effect ─────────
up() { curl -sf -m 5 "$1" >/dev/null 2>&1; }

if ! up "$SCRUPLE_CVM_SURROGATE/health"; then
  nohup python3 "$REPO/services/cvm-surrogate/surrogate.py" > "$SB/surrogate.log" 2>&1 &
  sleep 3
fi
if ! up "$WITNESS_SERVER_URL/health"; then
  ( cd /opt/scruple-witness && PORT=5899 DB_PATH="$SB/witness-scratch.db" \
      SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 nohup node server.js > "$SB/witness-5899.log" 2>&1 & )
  sleep 5
fi
if ! curl -s -m 5 -o /dev/null "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null; then
  ( cd "$REPO" && SCRUPLE_DIST_DIR=.next-blender-l2 nohup npx next dev -p 3902 > "$SB/app-3902.log" 2>&1 & )
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null)" != "000" ] && break
    sleep 10
  done
fi

cat > "$STATUS" <<HDR
# Overnight — Scruple for Blender to the L2 floor

Started $(date -u +%Y-%m-%dT%H:%M:%SZ). Detached; survives disconnect.
Specs: \`docs/wo/2026-09-07-blender-l2.md\`

**Sandbox** — nothing here touches production:
- witness  $WITNESS_SERVER_URL  (scratch DB; prod :5799 is NEVER contacted)
- app      $SCRUPLE_APP_URL  (own distDir + DB; live :3001 is NEVER contacted)
- surrogate $SCRUPLE_CVM_SURROGATE  (signs real ECDSA, SOFTWARE-backed — never record it as hardware)
- Blender  $(blender --version 2>/dev/null | head -1)

HDR

note "sandbox: witness=$(up "$WITNESS_SERVER_URL/health" && echo up || echo DOWN) surrogate=$(up "$SCRUPLE_CVM_SURROGATE/health" && echo up || echo DOWN) app=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities")"

COMMON="You are executing a work order on the Scruple for Blender addon.

  Addon repo: $ADDON  (local git; COMMIT your work, never push)
  Server repo: $REPO  (read for the SDK, the v2 routes and the canon docs)
  Full WO specs: $REPO/docs/wo/2026-09-07-blender-l2.md  — READ YOUR WO THERE FIRST.

SANDBOX — every endpoint you may use:
  witness    $WITNESS_SERVER_URL
  app        $SCRUPLE_APP_URL
  surrogate  $SCRUPLE_CVM_SURROGATE
  scratch    $SB

🔴 NEVER contact 127.0.0.1:5799 — the PRODUCTION witness, a live audit log.
🔴 NEVER contact :3001 — that is scruple.stooges.ai, live and unsupervised.
🔴 The surrogate reports protectionMode SOFTWARE truthfully. A leaf it signed is
   NOT hardware-backed. Record the assurance tier honestly or you have built the
   exact dishonesty the L2 floor exists to prevent.

Blender 3.0.1 is at /usr/bin/blender and RENDERS HEADLESS on this box —
verified: 'blender --background --factory-startup --python x.py', Cycles CPU,
produced a real PNG and a real .blend. Use real content; do not simulate what
you can generate.

HOW YOU ARE JUDGED — verify by side effect, not by report:
- A gate is met when you can point at an observable: a row in the scratch
  witness DB, bytes on disk that re-hash to a recorded value, a test that fails
  when you break the thing it covers.
- Pair every must-fire check with a must-NOT-fire control. A green test with no
  control proves only that it cannot fail.
- If a gate does not pass, say so plainly and keep the work. Do not narrow the
  WO to what happened to succeed, and do not report a partial result as done.
- Prefer Bash (cat/sed/heredocs) over Read/Edit/Write tools for file work.
- Leave the tree committed and the test suite runnable."

run_wo () {
  local name="$1" secs="$2" prompt="$3"
  note "START  $name"
  local t0=$SECONDS
  if timeout "$secs" claude -p "$COMMON

$prompt" --permission-mode bypassPermissions \
        >> "$SB/$name.log" 2>&1; then
    note "DONE   $name  ($(( (SECONDS-t0)/60 ))m)  commits=$(cd $ADDON && git rev-list --count HEAD)"
  else
    note "FAILED $name (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/$name.log"
  fi
}

run_wo WO-B1 3600  "Execute WO-B1 — The gap, measured. Inventory only; no fixes."
run_wo WO-B2 7200  "Execute WO-B2 — The addon consumes the SDK. WO-B1's gap.json is in $OUT."
run_wo WO-B3 7200  "Execute WO-B3 — The v2 witness path, at L2."
run_wo WO-B4 5400  "Execute WO-B4 — Store-and-forward, and gap detection."
run_wo WO-B5 7200  "Execute WO-B5 — The dashboard. Read app/embed/fusion/FusionPalette.tsx for the feature surface to match."
run_wo WO-B6 7200  "Execute WO-B6 — Real content, end to end."
run_wo WO-B7 3600  "Execute WO-B7 — Close out honestly. Read every report in $OUT and every log in $SB first."

note "ALL WORK ORDERS COMPLETE"
