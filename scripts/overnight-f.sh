#!/usr/bin/env bash
# F series — the E-series' own findings, closed. Detached; survives disconnect.
# Specs: docs/WORK-ORDERS-F.md   Context: docs/STATE.md section 4
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; WEB="/data/scruple-web"; ADDON="/data/scruple-blender"; SB="$REPO/.run"
STATUS="$REPO/docs/STATUS-F.md"; mkdir -p "$SB/tmp"
export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="/mnt/corpus/scruple-council-impl/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1
export TMPDIR="$SB/tmp"
note(){ printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }
up(){ curl -sf -m 5 "$1" >/dev/null 2>&1; }
: > "$STATUS"; note "F series start"
up "$SCRUPLE_CVM_SURROGATE/health" || { nohup python3 "$WEB/services/cvm-surrogate/surrogate.py" >"$SB/surrogate.log" 2>&1 & sleep 3; }
up "$WITNESS_SERVER_URL/health" || { ( cd /opt/scruple-witness && PORT=5899 DB_PATH=/mnt/corpus/scruple-council-impl/witness-scratch.db \
    SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 nohup node server.js >"$SB/witness.log" 2>&1 & ); sleep 5; }
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health" 2>/dev/null)" = "000" ]; then
  ( cd "$WEB" && SCRUPLE_DIST_DIR=.next-council nohup npx next dev -p 3902 >"$SB/app.log" 2>&1 & )
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health" 2>/dev/null)" != "000" ] && break; sleep 10; done
fi
note "sandbox witness=$(up "$WITNESS_SERVER_URL/health" && echo up || echo DOWN) surrogate=$(up "$SCRUPLE_CVM_SURROGATE/health" && echo up || echo DOWN) app=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health")"

COMMON="You are implementing a work order in the Scruple F series — closing the E-series' own findings.

  Desktop repo: $REPO   (the app, the gate, the driver, the WOs)
  Server repo:  $WEB    (the SDK, the v2 routes, the leaf, the canon docs)
  Addon repo:   $ADDON  (the Blender addon / Level-2 host adapter)
  READ FIRST:   $REPO/docs/WORK-ORDERS-F.md (your WO), then $REPO/docs/STATE.md
                section 4 — it is the E-series close-out and names what is missing.
                $REPO/docs/FINDINGS.md carries E7-1..E7-7 in full.

SANDBOX: witness $WITNESS_SERVER_URL · app $SCRUPLE_APP_URL · surrogate $SCRUPLE_CVM_SURROGATE
Blender 4.2.23 is at $REPO/vendor/blender/bin/blender (runs under qemu; slow but real).

🔴 NEVER modify /opt/scruple-witness. NEVER contact 127.0.0.1:5799 or :3001.
🔴 The surrogate is SOFTWARE-backed: passthrough or stale, NEVER verified.
🔴 Do NOT flip CHECKPOINT_VECTORS_SETTLED. Do NOT open the live witness database
   for writing — F4 works on the COPY at
   /mnt/corpus/scruple-council-impl/c7-rehearsal/witness-prod-copy.db
⚑ A Windows travel laptop is working from these same branches RIGHT NOW on
   WO-W1. Do not rewrite shared history, do not force-push, and do not edit
   docs/README-TRAVEL-LAPTOP.md or docs/WO-W1.md.
⚑ Do NOT edit a shell script while bash is running it — WO-E5 and WO-E7 both
   corrupted their own transcripts that way.

VERIFY BY SIDE EFFECT. Every gate names an observable AND a control that must
NOT fire. Demonstrate each control RED before your change and green after. An
inconclusive control is scored INCONCLUSIVE, never a pass. Prefer Bash. Run the
existing suites and do not leave them red. If a gate does not pass, say so
plainly and KEEP THE WORK — do not narrow the WO to what happened to succeed.
Write your report to $REPO/docs/WO-<id>.md and commit in the repo you changed."

run_wo(){ local n="$1" s="$2" p="$3"; note "START  $n"; local t0=$SECONDS
  if timeout "$s" claude -p "$COMMON

$p" --permission-mode bypassPermissions >>"$SB/$n.log" 2>&1; then
    note "DONE   $n  ($(( (SECONDS-t0)/60 ))m)  desktop=$(git -C "$REPO" rev-parse --short HEAD) web=$(git -C "$WEB" rev-parse --short HEAD) addon=$(git -C "$ADDON" rev-parse --short HEAD)"
  else note "FAILED $n (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/$n.log"; fi; }

run_wo WO-F1 5400 "Execute WO-F1 — the addon's Settings UI must bind on the manifest path, and get_base_url() must stop falling back to production. This unblocks the travel laptop."
run_wo WO-F2 5400 "Execute WO-F2 — WitnessWorker.stop() must not drop queued captures; they go to the durable spool or they are delivered."
run_wo WO-F3 7200 "Execute WO-F3 — the standalone addon declares the imported datablocks and their digests. Read the product decision in the WO and its reasoning before you start; it is taken, not open."
run_wo WO-F4 7200 "Execute WO-F4 — merkle_algorithm recorded on the SNAPSHOT copy, with a verifier that dispatches on it and defaults to REFUSE."
run_wo WO-F5 5400 "Execute WO-F5 — only if F1..F4 gates are green: the app refuses to serve leaf-writing routes on a stale schema."
note "ALL WORK ORDERS COMPLETE"
