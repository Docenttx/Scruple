#!/usr/bin/env bash
# E series — Blender on the host hook, plus the two server fixes that gate it.
# Detached; survives disconnect.
# Specs: docs/WORK-ORDERS-E.md   Design: docs/BLENDER.md then docs/HOST-HOOK.md
# Launch: nohup setsid bash scripts/overnight-blender-e.sh >/mnt/corpus/scruple-desktop/.run/runner-e.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; WEB="/data/scruple-web"; ADDON="/data/scruple-blender"; SB="$REPO/.run"
STATUS="$REPO/docs/STATUS-E.md"; mkdir -p "$SB/tmp"

export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="/mnt/corpus/scruple-council-impl/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1
export TMPDIR="$SB/tmp"
note(){ printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }
up(){ curl -sf -m 5 "$1" >/dev/null 2>&1; }

: > "$STATUS"
note "E series start"

# ── the sandbox. Reuse what is already up; never touch :5799 or :3001. ──
up "$SCRUPLE_CVM_SURROGATE/health" || { nohup python3 "$WEB/services/cvm-surrogate/surrogate.py" >"$SB/surrogate.log" 2>&1 & sleep 3; }
up "$WITNESS_SERVER_URL/health" || { ( cd /opt/scruple-witness && PORT=5899 DB_PATH=/mnt/corpus/scruple-council-impl/witness-scratch.db \
    SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 nohup node server.js >"$SB/witness.log" 2>&1 & ); sleep 5; }
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health" 2>/dev/null)" = "000" ]; then
  ( cd "$WEB" && SCRUPLE_DIST_DIR=.next-council nohup npx next dev -p 3902 >"$SB/app.log" 2>&1 & )
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health" 2>/dev/null)" != "000" ] && break; sleep 10; done
fi
note "sandbox witness=$(up "$WITNESS_SERVER_URL/health" && echo up || echo DOWN) surrogate=$(up "$SCRUPLE_CVM_SURROGATE/health" && echo up || echo DOWN) app=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/health")"

COMMON="You are implementing a work order in the Scruple E series — Blender on the host hook.

  Desktop repo: $REPO        (the app, the gate, the driver; commit here)
  Server repo:  $WEB         (the SDK, the v2 routes, the Next UI, the canon docs)
  Addon repo:   $ADDON       (the existing standalone Blender addon, 308 tests)
  READ FIRST:   $REPO/docs/BLENDER.md, then $REPO/docs/HOST-HOOK.md,
                then your WO in $REPO/docs/WORK-ORDERS-E.md
  CONTEXT:      $REPO/docs/STATE.md is the D-series close-out. Its section 4 is
                the list of what is honestly missing; two E work orders come
                straight out of it.

SANDBOX: witness $WITNESS_SERVER_URL · app $SCRUPLE_APP_URL · surrogate $SCRUPLE_CVM_SURROGATE

🔴 NEVER modify /opt/scruple-witness — it serves witness.scruple.ai and is live.
🔴 NEVER contact 127.0.0.1:5799 (production witness) or :3001 (live site).
🔴 The surrogate is SOFTWARE-backed; a leaf it signs is passthrough or stale,
   NEVER verified. Do not work around migration 053.
🔴 Do NOT flip CHECKPOINT_VECTORS_SETTLED. None of the four Merkle
   implementations passes the shared vectors (WO-C6); the cutover is WO-C7 and
   its witness deploy is a founder decision.
⚑ /usr/bin/blender is 3.0.1 — BELOW the addon's own declared minimum of 3.6.0,
   and the shipping manifest path needs 4.2.0. WO-E3 fixes this and nothing
   downstream is trustworthy until it passes.
⚑ No display: xvfb-run -a -s \"-screen 0 1280x900x24\". SCREENSHOTS COME BACK
   BLANK under llvmpipe — never gate on pixels. Ask the layout engine or the
   filesystem. Reap any Xvfb you orphan.

VERIFY BY SIDE EFFECT. Every gate names an observable AND a control that must
NOT fire. Demonstrate each control red before your change and green after. An
inconclusive control is scored INCONCLUSIVE, never as a pass. Prefer Bash over
Read/Edit/Write. Run existing suites; do not leave them red. If a gate does not
pass, say so plainly and KEEP THE WORK — do not narrow the WO to what happened
to succeed. Write your report to $REPO/docs/WO-<id>.md and commit it."

run_wo(){ local n="$1" s="$2" p="$3"; note "START  $n"; local t0=$SECONDS
  if timeout "$s" claude -p "$COMMON

$p" --permission-mode bypassPermissions >>"$SB/$n.log" 2>&1; then
    note "DONE   $n  ($(( (SECONDS-t0)/60 ))m)  desktop=$(git -C "$REPO" rev-parse --short HEAD) web=$(git -C "$WEB" rev-parse --short HEAD)"
  else note "FAILED $n (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/$n.log"; fi; }

run_wo WO-E1 5400 "Execute WO-E1 — the C2PA signer must refuse a certificate whose public key is not the signing key's. This is a SERVER repo change; commit it in $WEB."
run_wo WO-E2 7200 "Execute WO-E2 — declared_uncaptured, the absence set, carrying the scope it enumerated over. SERVER repo. Settle the scope rule in writing BEFORE building to it."
run_wo WO-E3 5400 "Execute WO-E3 — install Blender 4.2 LTS or newer into this repo's tree and prove the shipped addon zip enables through the MANIFEST path, headless."
run_wo WO-E4 7200 "Execute WO-E4 — the Blender addon registers as a Level-2 host adapter and a generation's leaf reads host_semantics: supplied with the scene facts."
run_wo WO-E5 5400 "Execute WO-E5 — the Blender region in the dashboard, rendered from capabilities, ABSENT when Blender is not installed."
run_wo WO-E6 7200 "Execute WO-E6 — one generation started inside Blender, through the gate, landing ONE leaf carrying the graph, the model fingerprints AND the scene semantics."
run_wo WO-E7 5400 "Execute WO-E7 — the two products side by side, the honest difference between them stated field by field, and docs/STATE.md updated."
note "ALL WORK ORDERS COMPLETE"
