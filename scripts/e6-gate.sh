#!/usr/bin/env bash
# WO-E6 — ONE GENERATION, STARTED INSIDE BLENDER, THROUGH THE GATE.
#
#   npm run e6      (bash scripts/e6-gate.sh)
#
# The work order: "one leaf, from one generation started in Blender, carrying
# the workflow graph, model_fingerprints computed from the model files, AND
# host_semantics: supplied with the scene facts. Re-hash the artifact from the
# bytes on disk and read the leaf out of the witness's own sqlite file, from the
# shell, outside node."
#
# So stage 5 is bash and sqlite3 and sha256sum, with no node in it at all.
#
# 🔴 Rails: the scratch witness on 5899, the scratch app on 3902, the surrogate
# on 8799. Nothing here contacts :5799 or :3001, and every leaf it produces is
# `stale` by construction.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
RUN="$REPO/.run/e6"; mkdir -p "$RUN"
DB="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
WDB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
APP="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"

ok=0; fail=0
check(){ # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '   ok    %-58s %s\n' "$1" "$3"; ok=$((ok+1))
  else printf '   FAIL  %-58s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
note(){ printf '\n══ %s\n' "$1"; }

note "STAGE 0 — what is under test, named rather than described"
BRIDGE_JSON="$RUN/bridges/INSTALLED.json"
if [ ! -f "$BRIDGE_JSON" ]; then echo "   run scripts/e6-install-bridge.sh first"; exit 2; fi
python3 - "$BRIDGE_JSON" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(f"   bridge       {d['bridge']} {d['tag']} ({d['commit'][:12]})")
print(f"   add-on zip   {d['addon_zip_sha256']}")
print(f"   custom nodes {d['custom_nodes_dir']}")
PY
echo "   blender      $(vendor/blender/bin/blender --version 2>/dev/null | head -1)"
echo "   scruple zip  $(sha256sum /data/scruple-blender/dist/scruple-blender-0.1.0.zip | cut -c1-64)"

note "STAGE 1 — THE CONTROL, RED BEFORE THE CHANGE"
# Resolved FROM THE CHANGE, never from HEAD: the parent of the commit that first
# added app/ipc-blender-generate.js. A worktree there has the same gate, the
# same addon and the same bridge, and no channel through which a Blender can be
# asked to generate. The observable is the BRIDGE METHOD LIST the renderer
# reports — read out of a real window in a real app, not out of this file.
ADDED="$(git log --diff-filter=A --format=%H -1 -- app/ipc-blender-generate.js)"
if [ -z "$ADDED" ]; then
  echo "   ⚑ app/ipc-blender-generate.js is not committed yet — stage 1 runs after the commit"
  BEFORE=""
else
  BEFORE="$(git rev-parse "$ADDED^")"
  WT="$RUN/before-tree"
  rm -rf "$WT"; git worktree remove --force "$WT" 2>/dev/null || true
  git worktree add -q --detach "$WT" "$BEFORE"
  ln -sfn "$REPO/node_modules" "$WT/node_modules" 2>/dev/null || true
  ln -sfn "$REPO/vendor/blender" "$WT/vendor/blender" 2>/dev/null || true
  ( cd "$WT" && SCRUPLE_DESKTOP_ROOT="$WT" timeout 600 node scripts/desktop-run.mjs ping --timeout 300000 \
      > "$RUN/before-ping.log" 2>&1 )
  B_BEFORE="$(grep -o 'bridge \[[^]]*\]' "$RUN/before-ping.log" | head -1)"
  echo "   at $BEFORE (parent of $ADDED)"
  echo "   $B_BEFORE"
  case "$B_BEFORE" in *blenderGenerate*) HAS_BEFORE=yes;; *) HAS_BEFORE=no;; esac
  check "the before-tree app exposes no blenderGenerate channel" "no" "$HAS_BEFORE"
fi
timeout 600 node scripts/desktop-run.mjs ping --timeout 300000 > "$RUN/after-ping.log" 2>&1
B_AFTER="$(grep -o 'bridge \[[^]]*\]' "$RUN/after-ping.log" | head -1)"
echo "   $B_AFTER"
case "$B_AFTER" in *blenderGenerate*) HAS_AFTER=yes;; *) HAS_AFTER=no;; esac
check "and this tree does" "yes" "$HAS_AFTER"

note "STAGE 2 — THE GENERATION, STARTED IN BLENDER, THROUGH THE GATE"
timeout 1800 node scripts/desktop-run.mjs blender-generate --timeout 900000 > "$RUN/gate-clean.log" 2>&1
CLEAN_EXIT=$?
tail -45 "$RUN/gate-clean.log"
check "the scenario passed" "0" "$CLEAN_EXIT"
REPORT="$(ls -td "$REPO"/.run/d2/clean-* | head -1)/report.json"
PASSED=$(python3 -c "import json;d=json.load(open('$REPORT'));print(sum(1 for c in d['checks'] if c['pass']))")
FAILED=$(python3 -c "import json;d=json.load(open('$REPORT'));print(len(d['failed']))")
check "assertions failed" "0" "$FAILED"
echo "   $PASSED assertions passed · $REPORT"

note "STAGE 3 — WHAT THE RUN ACTUALLY DID, out of its own record"
python3 - "$REPORT" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
r=d['spec']  # the materialised spec, for the fixture
res=json.load(open(f"{d['runDir']}/result.json"))
g=res['steps']['gen']['value']; b=g['blenderReport']
print(f"   bridge         {b['bridge_module']} → {b['bridge_prefs']['server_address']}")
print(f"   gate           {res['steps']['launch']['value']['gate']['url']}")
print(f"   prompt id      {g['promptId']}  (minted by ComfyUI; the bridge sent none)")
print(f"   announced      {b['announce_status']} in {b.get('announce_seconds')}s")
print(f"   ⚑ margin       {b.get('announce_margin_seconds')}s between the announcement and the download")
print(f"   scene          {b['scene_as_blender_holds_it']}")
print(f"   artifact       {g['images'][0]['sha256']}  {g['images'][0]['bytes']} bytes")
print(f"   phantom        {b.get('phantom_scene')} under {b.get('phantom_announced_under')}")
PY

note "STAGE 4 — ⚑ FROM THE SHELL, OUTSIDE NODE: the bytes, then the leaf"
RUNDIR="$(ls -td "$REPO"/.run/d2/clean-* | head -1)"
HASH="$(python3 -c "import json;print(json.load(open('$RUNDIR/result.json'))['steps']['gen']['value']['images'][0]['sha256'])")"
STORE="$(python3 -c "import json;print(json.load(open('$RUNDIR/result.json'))['steps']['gen']['value']['images'][0]['storePath'])")"
BRIDGE_COPY="$(python3 -c "import json;print(json.load(open('$RUNDIR/result.json'))['steps']['gen']['value']['images'][0]['bridgePath'])")"
echo "   artifact       $STORE"
RE_STORE="$(sha256sum "$STORE" | cut -d' ' -f1)"
RE_BRIDGE="$(sha256sum "$BRIDGE_COPY" | cut -d' ' -f1)"
check "sha256sum of the stored bytes is the run's hash" "$HASH" "$RE_STORE"
check "…and so is the copy in the BRIDGE's own outputs folder" "$HASH" "$RE_BRIDGE"

# The witness's own file. A different service, a different database.
W="$(sqlite3 "file:$WDB?mode=ro" -batch "SELECT COUNT(*) FROM witnesses WHERE content_hash='$HASH';")"
[ "$W" -ge 1 ] && WOK=yes || WOK=no
check "the witness's sqlite file holds a leaf for those bytes" "yes" "$WOK"
echo "   witness rows   $(sqlite3 "file:$WDB?mode=ro" -batch "SELECT group_concat(id||':'||substr(leaf_hash,1,12),' ') FROM witnesses WHERE content_hash='$HASH';")"

# And the app database, one row per leaf, printed rather than summarised.
echo
echo "   THE LEAF, read with sqlite3:"
sqlite3 "file:$DB?mode=ro" -batch -line \
  "SELECT id, leaf_kind, substr(workflow_hash,1,16) AS workflow_hash,
          substr(model_fingerprints_hash,1,16) AS model_fingerprints_hash,
          host, host_adapter, host_semantics, attestation_basis, attestation_profile
     FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;" | sed 's/^/   /'
echo
echo "   THE SCENE ON IT:"
sqlite3 "file:$DB?mode=ro" -batch "SELECT host_evidence FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;" | fold -w 92 | sed 's/^/   /'
echo
echo "   THE MODEL FINGERPRINT ON THE SAME LEAF:"
sqlite3 "file:$DB?mode=ro" -batch "SELECT model_fingerprints FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;" | fold -w 92 | sed 's/^/   /'
echo

for f in workflow_hash model_fingerprints host_evidence; do
  V="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT CASE WHEN $f IS NULL OR $f='' THEN 'null' ELSE 'present' END FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;")"
  check "⚑ one leaf carries $f" "present" "$V"
done
SEM="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT host_semantics FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;")"
check "…and says the meaning was supplied" "supplied" "$SEM"
BASIS="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT DISTINCT attestation_basis FROM iterations WHERE output_hash='$HASH';")"
check "🔴 no leaf for these bytes claims verified" "stale" "$BASIS"

# The scene string, from the shell, against the announcement file Blender wrote.
ANN="$(python3 -c "import json;print(json.load(open('$RUNDIR/result.json'))['steps']['gen']['value']['announcePath'])")"
SCENE_FILE="$(python3 -c "import json;print(json.load(open('$ANN'))['scene'])")"
SCENE_LEAF="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT json_extract(host_evidence,'\$.scene') FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;")"
check "the scene on the leaf is the scene in Blender's own file" "$SCENE_FILE" "$SCENE_LEAF"

# ⚑ And the phantom, asked of the WHOLE table.
PH="$(python3 -c "import json;print(json.load(open('$RUNDIR/result.json'))['steps']['gen']['value']['blenderReport']['phantom_scene'])")"
PHN="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT COUNT(*) FROM iterations WHERE host_evidence LIKE '%$PH%';")"
check "⚑ no leaf anywhere carries the scene nobody generated from" "0" "$PHN"

note "STAGE 5 — the public route agrees, over HTTP"
LEAF="$(sqlite3 "file:$DB?mode=ro" -batch "SELECT id FROM iterations WHERE output_hash='$HASH' ORDER BY id DESC LIMIT 1;")"
RC="$(curl -s -o "$RUN/receipt.json" -w '%{http_code}' "$APP/api/v2/receipt/$LEAF")"
check "GET /api/v2/receipt/$LEAF" "200" "$RC"
python3 -c "
import json;d=json.load(open('$RUN/receipt.json'))
print('   content_hash', d['content_hash'])
print('   basis       ', d['attestation_basis'])
"

note "STAGE 6 — THE CONTROLS, each run for real"
sweep(){ # sweep <mutation>
  timeout 1800 node scripts/desktop-run.mjs blender-generate --break "$1" --expect-fail --timeout 900000 \
    > "$RUN/break-$1.log" 2>&1
  local rc=$?
  local rep; rep="$(ls -td "$REPO"/.run/d2/break-"$1"-* | head -1)/report.json"
  echo "   ── $1 (exit $rc)"
  python3 - "$rep" <<'PY' | sed 's/^/      /'
import json,sys
d=json.load(open(sys.argv[1]))
for f in d['failed']: print("RED  " + f)
PY
  check "$1 reddened at least one assertion" "yes" "$(python3 -c "
import json;d=json.load(open('$rep'));print('yes' if d['failed'] else 'no')")"
}
for m in bridge-around-the-gate blender-does-not-announce announce-the-phantom-under-the-real-id model-swap; do
  sweep "$m"
done

note "STAGE 7 — ⚑ what the bypassed run left behind"
# WO-E6's control (b) in full: bypassing the gate must produce a BLIND record,
# not an absent one. Read from the shell, out of the app database, for the run
# whose bridge was pointed at ComfyUI.
BRUN="$(ls -td "$REPO"/.run/d2/break-bridge-around-the-gate-* | head -1)"
BHASH="$(python3 -c "
import json;print(json.load(open('$BRUN/result.json'))['steps']['gen']['value']['images'][0]['sha256'])" 2>/dev/null)"
if [ -n "$BHASH" ]; then
  echo "   artifact       $BHASH"
  sqlite3 "file:$DB?mode=ro" -batch -line \
    "SELECT id, leaf_kind, COALESCE(workflow_hash,'(null)') AS workflow_hash,
            COALESCE(model_fingerprints_hash,'(null)') AS model_fingerprints_hash,
            COALESCE(host,'(null)') AS host, host_semantics
       FROM iterations WHERE output_hash='$BHASH' ORDER BY id DESC LIMIT 1;" | sed 's/^/   /'
  BW="$(sqlite3 "file:$WDB?mode=ro" -batch "SELECT COUNT(*) FROM witnesses WHERE content_hash='$BHASH';")"
  [ "$BW" -ge 1 ] && BWOK=yes || BWOK=no
  check "⚑ the bypassed artifact IS witnessed anyway (the watcher)" "yes" "$BWOK"
  check "…with no graph" "(null)" "$(sqlite3 "file:$DB?mode=ro" -batch "SELECT COALESCE(workflow_hash,'(null)') FROM iterations WHERE output_hash='$BHASH' ORDER BY id DESC LIMIT 1;")"
  # ⚑ FINDING E6-5. The work order predicted `blind` here and WO-D4 measured
  # `blind` — with nobody registered. The addon IS registered in this run, so
  # the honest value is `declined`: an adapter was there and had nothing to say
  # about an observation the gate never correlated to a prompt. The leaf still
  # NAMES the host, which is a fact about the deployment rather than about this
  # artifact. Asserted as measured, not as predicted.
  check "…and DECLINED, not blind — the adapter is registered (E6-5)" "declined" "$(sqlite3 "file:$DB?mode=ro" -batch "SELECT host_semantics FROM iterations WHERE output_hash='$BHASH' ORDER BY id DESC LIMIT 1;")"
  check "…and it still names the host, which stayed true" "blender" "$(sqlite3 "file:$DB?mode=ro" -batch "SELECT COALESCE(host,'(null)') FROM iterations WHERE output_hash='$BHASH' ORDER BY id DESC LIMIT 1;")"
else
  echo "   FAIL  the bypassed run produced no artifact to look at — INCONCLUSIVE, not a pass"
  fail=$((fail+1))
fi

note "STAGE 8 — the audit sweep, exact sets"
timeout 3600 node scripts/desktop-run.mjs blender-generate --audit --timeout 900000 > "$RUN/gate-audit.log" 2>&1
AUDIT_EXIT=$?
sed -n '/audit sweep/,$p' "$RUN/gate-audit.log" | tail -30
check "every mutation reddened exactly its declared set" "0" "$AUDIT_EXIT"

note "STAGE 9 — the suites that must not go red"
timeout 1800 node scripts/desktop-run.mjs blender-host --timeout 900000 > "$RUN/regress-e4.log" 2>&1
check "WO-E4's blender-host scenario still passes" "0" "$?"
timeout 1800 node scripts/desktop-run.mjs comfy-generate --timeout 900000 > "$RUN/regress-d4.log" 2>&1
check "WO-D4's comfy-generate scenario still passes" "0" "$?"
( cd /data/scruple-blender && timeout 900 python3 -m pytest -q tests > "$RUN/regress-addon.log" 2>&1 )
check "the addon suite is still green" "0" "$?"
tail -3 "$RUN/regress-addon.log" | sed 's/^/   /'

note "VERDICT"
if [ "$fail" -eq 0 ]; then
  echo "════ WO-E6 GATE PASSED ════   $ok checks ok / 0 FAIL"
  exit 0
else
  echo "════ WO-E6 GATE FAILED ════   $ok ok / $fail FAIL"
  exit 1
fi
