#!/usr/bin/env bash
# Scruple Desktop Studio to L2. Detached; survives disconnect.
# Specs: docs/WORK-ORDERS.md   Design: docs/DESIGN.md
# Launch: nohup setsid bash scripts/overnight-desktop-l2.sh >/mnt/corpus/scruple-desktop/.run/runner.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; WEB="/data/scruple-web"; SB="$REPO/.run"
STATUS="$REPO/docs/STATUS.md"; mkdir -p "$SB/tmp"

export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="/mnt/corpus/scruple-council-impl/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1
export TMPDIR="$SB/tmp"
note(){ printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }
up(){ curl -sf -m 5 "$1" >/dev/null 2>&1; }

: > "$STATUS"
note "waiting for the council run to finish — it shares this sandbox"
# ── chain, do not collide: the council series edits /data/scruple-web too ──
C="$WEB/docs/canon/council-impl/STATUS.md"
for _ in $(seq 1 240); do             # up to 4h
  grep -q "ALL WORK ORDERS COMPLETE" "$C" 2>/dev/null && { note "council run complete — starting"; break; }
  pgrep -f "overnight-council-impl\.sh" >/dev/null 2>&1 || { note "council runner gone before completing — starting anyway"; break; }
  sleep 60
done

up "$SCRUPLE_CVM_SURROGATE/health" || { nohup python3 "$WEB/services/cvm-surrogate/surrogate.py" >"$SB/surrogate.log" 2>&1 & sleep 3; }
up "$WITNESS_SERVER_URL/health" || { ( cd /opt/scruple-witness && PORT=5899 DB_PATH=/mnt/corpus/scruple-council-impl/witness-scratch.db \
    SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 nohup node server.js >"$SB/witness.log" 2>&1 & ); sleep 5; }
if ! curl -s -m 5 -o /dev/null "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null; then
  ( cd "$WEB" && SCRUPLE_DIST_DIR=.next-council nohup npx next dev -p 3902 >"$SB/app.log" 2>&1 & )
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null)" != "000" ] && break; sleep 10; done
fi
note "sandbox witness=$(up "$WITNESS_SERVER_URL/health" && echo up || echo DOWN) surrogate=$(up "$SCRUPLE_CVM_SURROGATE/health" && echo up || echo DOWN) app=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities")"

COMMON="You are implementing a work order for Scruple Desktop Studio.

  Desktop repo: $REPO   (commit here; do not push)
  Server repo:  $WEB    (the SDK, the v2 routes, the Next UI, the canon docs)
  READ FIRST:   $REPO/docs/DESIGN.md then your WO in $REPO/docs/WORK-ORDERS.md

SANDBOX: witness $WITNESS_SERVER_URL · app $SCRUPLE_APP_URL · surrogate $SCRUPLE_CVM_SURROGATE

🔴 NEVER modify /opt/scruple-witness. NEVER contact 127.0.0.1:5799 or :3001.
🔴 The surrogate is SOFTWARE-backed; a leaf it signs is passthrough, never verified.
⚑ Electron is NOT installed — install it here. No display: use
   xvfb-run -a -s \"-screen 0 1280x900x24\". SCREENSHOTS COME BACK BLANK under
   llvmpipe (verified three ways against a detector proven on real renders) —
   never gate on pixels.

VERIFY BY SIDE EFFECT. Every gate names an observable AND a control that must
NOT fire. Demonstrate each control red before your change and green after.
Prefer Bash over Read/Edit/Write. Run existing suites; do not leave them red.
If a gate does not pass, say so plainly and keep the work."

run_wo(){ local n="$1" s="$2" p="$3"; note "START  $n"; local t0=$SECONDS
  if timeout "$s" claude -p "$COMMON

$p" --permission-mode bypassPermissions >>"$SB/$n.log" 2>&1; then
    note "DONE   $n  ($(( (SECONDS-t0)/60 ))m)  head=$(git -C "$REPO" rev-parse --short HEAD)"
  else note "FAILED $n (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/$n.log"; fi; }

run_wo WO-D1 5400 "Execute WO-D1 — Electron runs headlessly under xvfb against the scratch app, with an IPC ping."
run_wo WO-D2 5400 "Execute WO-D2 — scripts/desktop-run.mjs, the headless driver mirroring scruple-web/scripts/scruple-run.ts."
run_wo WO-D3 7200 "Execute WO-D3 — the vault model rebuilt as a capture surface on the current SDK."
run_wo WO-D4 7200 "Execute WO-D4 — the gate in the path, and model fingerprints from the LOCAL model store."
run_wo WO-D5 7200 "Execute WO-D5 — the canon UI design ported into the shared Next theme, rendered from capabilities."
run_wo WO-D6 5400 "Execute WO-D6 — the host-agnostic ComfyUI hook: Level 1 blind capture, Level 2 host adapter."
run_wo WO-D7 5400 "Execute WO-D7 — prove the whole flow and write docs/STATE.md honestly."
note "ALL WORK ORDERS COMPLETE"
