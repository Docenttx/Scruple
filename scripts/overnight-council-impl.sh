#!/usr/bin/env bash
# Implement the settled council design. Detached; survives disconnect.
# Specs: docs/wo/2026-09-09-council-implementation.md
# Launch: nohup setsid bash scripts/overnight-council-impl.sh >/mnt/corpus/scruple-council-impl/runner.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; SB="/mnt/corpus/scruple-council-impl"
OUT="$REPO/docs/canon/council-impl"; STATUS="$OUT/STATUS.md"
mkdir -p "$OUT" "$SB/tmp"

export WITNESS_SERVER_URL="http://127.0.0.1:5899"
export SCRUPLE_APP_URL="http://127.0.0.1:3902"
export SCRUPLE_DB_PATH="$SB/scruple-scratch.db"
export SCRUPLE_CVM_SURROGATE="http://127.0.0.1:8799"
export SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1
export TMPDIR="$SB/tmp"

note(){ printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$1" >> "$STATUS"; }
up(){ curl -sf -m 5 "$1" >/dev/null 2>&1; }

up "$SCRUPLE_CVM_SURROGATE/health" || { nohup python3 "$REPO/services/cvm-surrogate/surrogate.py" >"$SB/surrogate.log" 2>&1 & sleep 3; }
up "$WITNESS_SERVER_URL/health" || { ( cd /opt/scruple-witness && PORT=5899 DB_PATH="$SB/witness-scratch.db" \
    SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 nohup node server.js >"$SB/witness-5899.log" 2>&1 & ); sleep 5; }
[ -f "$SCRUPLE_DB_PATH" ] || ( cd "$REPO" && npx tsx scripts/migrate.ts >"$SB/migrate.log" 2>&1 )
if ! curl -s -m 5 -o /dev/null "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null; then
  ( cd "$REPO" && SCRUPLE_DIST_DIR=.next-council nohup npx next dev -p 3902 >"$SB/app-3902.log" 2>&1 & )
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities" 2>/dev/null)" != "000" ] && break; sleep 10; done
fi

cat > "$STATUS" <<HDR
# Implementing the settled council design

Started $(date -u +%Y-%m-%dT%H:%M:%SZ). Detached. Specs: \`docs/wo/2026-09-09-council-implementation.md\`
Sandbox: witness $WITNESS_SERVER_URL · app $SCRUPLE_APP_URL · surrogate $SCRUPLE_CVM_SURROGATE
🔴 /opt/scruple-witness is NOT modified by any WO here. WO-C6 is plan-only.

HDR
note "sandbox witness=$(up "$WITNESS_SERVER_URL/health" && echo up || echo DOWN) surrogate=$(up "$SCRUPLE_CVM_SURROGATE/health" && echo up || echo DOWN) app=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SCRUPLE_APP_URL/api/v2/capabilities")"

COMMON="You are implementing a work order from the settled Blender x ComfyUI council design.

  Repo: $REPO   Specs: $REPO/docs/wo/2026-09-09-council-implementation.md — READ YOUR WO THERE FIRST.
  The settled design: $REPO/docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md (large — read §1, §2 and Appendix C, not the transcripts).

SANDBOX — the only endpoints you may use:
  witness $WITNESS_SERVER_URL · app $SCRUPLE_APP_URL · surrogate $SCRUPLE_CVM_SURROGATE · scratch $SB

🔴 NEVER modify /opt/scruple-witness — it serves witness.scruple.ai and holds an
   append-only audit log whose RVN/Arweave anchors CANNOT be recomputed.
🔴 NEVER contact 127.0.0.1:5799 (production witness) or :3001 (the live site).
🔴 The surrogate is SOFTWARE-backed. A leaf it signed is never hardware-backed.

VERIFY BY SIDE EFFECT. Every gate in your WO names an observable AND a control
that must not fire. Demonstrate each control RED before your change and green
after, and record the runs. A green test with no control proves only that it
cannot fail — this whole series exists because a prose rule failed that way
inside the council itself.

Prefer Bash (cat/sed/heredocs) over Read/Edit/Write. Run the existing suites
(npm run test:v2, the scruple-capture and host-sdk suites) and do not leave them
red. Commit your work; do not push. If a gate does not pass, say so plainly and
keep the work — do not narrow the WO to what happened to succeed."

run_wo(){ local n="$1" s="$2" p="$3"; note "START  $n"; local t0=$SECONDS
  if timeout "$s" claude -p "$COMMON

$p" --permission-mode bypassPermissions >>"$SB/$n.log" 2>&1; then
    note "DONE   $n  ($(( (SECONDS-t0)/60 ))m)  head=$(git -C "$REPO" rev-parse --short HEAD)"
  else note "FAILED $n (exit $?, $(( (SECONDS-t0)/60 ))m) — see $SB/$n.log"; fi; }

run_wo WO-C1 7200 "Execute WO-C1 — the three-valued attestation basis, stale until the roots agree, and the close_detection validator rejection."
run_wo WO-C2 5400 "Execute WO-C2 — the resolution handles go inside the signed preimage (lib/leaf/componentPreimage.ts)."
run_wo WO-C3 5400 "Execute WO-C3 — retention_policy_digest binds duration, settlement_deadline, expired against a named clock."
run_wo WO-C4 5400 "Execute WO-C4 — storage confinement: startup refusal plus per-leaf raw stat() st_dev re-read at emission."
run_wo WO-C5 5400 "Execute WO-C5 — upstream restart detection via /system_stats and history epoch identity."
run_wo WO-C6 7200 "Execute WO-C6 — canonical Merkle PLAN AND VECTORS ONLY. Change no root calculation and do not touch /opt/scruple-witness."
note "ALL WORK ORDERS COMPLETE"
