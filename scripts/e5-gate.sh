#!/usr/bin/env bash
# WO-E5 gate. One command, non-zero if anything the work order asked for is
# not upheld.
#
#   stage 0   what is on this box, read from the binary and the endpoint
#   stage 1   THE RED BEFORE, read out of git: the region did not exist and
#             nothing announced what was on the box
#   stage 2   the shape, from the shell — the region follows the ANNOUNCEMENT,
#             both directions, counted in the served bytes
#   THE GATE  the region in a real Electron window: the version out of the
#             running binary, the addon's enabled state, and a bridge pointed
#             at the port the gate allocated
#   stage 4   ⚑ THE WORK ORDER'S CONTROL — no Blender, and the region is
#             ABSENT: count 0 AND zero occurrences in the document
#   stage 5   the three readings re-taken FROM THE SHELL, outside node and
#             outside the app, against the same Blender profile
#   control A an unknown host app is REFUSED, never dropped
#   control B a passing run must NOT satisfy --expect-fail
#   control C the audit sweeps — every mutation reddens exactly its target
#   control D WO-D5 still passes, and the server's own suites are green
#
# Nothing here reads a pixel and nothing here reads a log line for its verdict:
# every assertion is a JSON field returned by bpy or by an IPC handler, a node
# in the served document, or an HTTP status.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
export SCRUPLE_APP_URL="$APP_URL"
export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
export SCRUPLE_WITNESS_DB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
export SCRUPLE_BDK_ALLOW_DEV="${SCRUPLE_BDK_ALLOW_DEV:-1}"
BL="$ROOT/vendor/blender/bin/blender"
ZIP="${E4_ZIP:-/data/scruple-blender/dist/scruple-blender-0.1.0.zip}"
WORK="$ROOT/.run/e5"
rc=0

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }
ok(){   printf '   ok    %s\n' "$1"; }
bad(){  printf '   FAIL  %s\n' "$1"; rc=1; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — got '$2', wanted '$3'"; fi; }
newest(){ ls -dt .run/d2/clean-* 2>/dev/null | head -1; }
field(){ python3 -c "import json,sys;d=json.load(open(sys.argv[1]));
import functools
cur=d
for p in sys.argv[2].split('.'):
    cur=cur[int(p)] if p.isdigit() else cur[p]
print(cur)" "$1" "$2"; }

[ -x "$BL" ] || { echo "!! $BL missing — run scripts/e3-install-blender.sh"; exit 2; }
[ -f "$ZIP" ] || { echo "!! $ZIP missing — run build/build_addon.sh in the addon repo"; exit 2; }
mkdir -p "$WORK"

stage "stage 0 — what is on this box"
BLV="$("$BL" --version 2>/dev/null | sed -n 's/^Blender \([0-9.]*\).*/\1/p' | head -1)"
printf '   %-32s %s\n' "vendor/blender/bin/blender" "$BLV"
printf '   %-32s %s\n' "the addon zip" "$(sha256sum "$ZIP" | cut -c1-16)…"
printf '   %-32s %s\n' "the app" "$APP_URL"
[ -n "$BLV" ] && ok "the binary answers --version" || bad "no version out of $BL"
check "the capabilities endpoint answers" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktop")" "200"

stage "stage 1 — the RED BEFORE, read out of git"
# Resolved FROM THE CHANGE, never from HEAD: the parent of the commit that
# first ADDED each file cannot move, so this keeps meaning the same thing
# however many work orders land after it (the bug WO-D6 found in D5's stage 1).
D_COMMIT=$(git log --diff-filter=A --format=%H -- app/ipc-blender.js | tail -1)
D_BEFORE="${D_COMMIT:+$D_COMMIT^}"; D_BEFORE="${D_BEFORE:-HEAD}"
W_COMMIT=$(git -C "$WEB" log -S"'blender',          // ⚑ WO-E5" --format=%H -- lib/v2/deployment.ts | tail -1)
W_BEFORE="${W_COMMIT:+$W_COMMIT^}"; W_BEFORE="${W_BEFORE:-HEAD}"
echo "   (desktop before-tree $D_BEFORE · web before-tree $W_BEFORE)"
check "a blender region in the server's region list BEFORE" \
  "$(git -C "$WEB" show "$W_BEFORE:lib/v2/deployment.ts" 2>/dev/null | grep -c "^  'blender',")" "0"
check "a blender renderer in the dashboard BEFORE" \
  "$(git -C "$WEB" show "$W_BEFORE:components/studio/regions.tsx" 2>/dev/null | grep -c "^  blender:")" "0"
check "an x-scruple-host-apps announcement BEFORE" \
  "$(git show "$D_BEFORE:app/main-modular.js" 2>/dev/null | grep -c 'host-apps')" "0"
before_detail=$(git show "$D_BEFORE:app/ipc-profile.js" 2>/dev/null | grep -c "not installed in this app yet")
[ "$before_detail" -ge 1 ] \
  && ok "the app said 'not installed in this app yet' BEFORE ($before_detail)" \
  || bad "expected the pre-change app to report Blender as not installed"
check "it still says that AFTER" "$(grep -c 'not installed in this app yet' app/ipc-profile.js)" "0"
# ⚑ Including in a comment. The first run of this gate went red here because a
# comment explaining the change quoted the sentence it retired, and a control
# that matches its own documentation is not measuring the code. The comment was
# reworded; the check was widened rather than narrowed.
check "…anywhere under app/" \
  "$(grep -rc 'not installed in this app yet' app/ 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')" "0"

stage "stage 2 — the shape follows the ANNOUNCEMENT, from the shell"
# Independent of node, of the driver and of the app process: curl and grep.
none=$(curl -s -m 60 -H 'x-scruple-profile: desktop' "$APP_URL/studio")
said=$(curl -s -m 60 -H 'x-scruple-profile: desktop' -H 'x-scruple-host-apps: comfyui,blender' "$APP_URL/studio")
looked=$(curl -s -m 60 -H 'x-scruple-profile: desktop' -H 'x-scruple-host-apps: comfyui' "$APP_URL/studio")
web=$(curl -s -m 60 -H 'x-scruple-profile: web' -H 'x-scruple-host-apps: comfyui,blender' "$APP_URL/studio")
n(){ printf '%s' "$1" | grep -o "$2" | wc -l; }
check "the region when a Blender is announced"        "$(n "$said" 'data-region="blender"')" "1"
check "the region when the host looked and found none" "$(n "$looked" 'data-region="blender"')" "0"
check "the region when nothing was announced"          "$(n "$none" 'data-region="blender"')" "0"
check "the region on a served deployment that was told" "$(n "$web" 'data-region="blender"')" "0"
# ⚑ ABSENT, NOT EMPTY: no OCCURRENCE anywhere in the document, which is the
# only form that catches a region drawn and hidden.
check "occurrences of the host-facts panel with none announced" "$(n "$none" 'data-host-fact="blender"')" "0"
# …and the APP is still listed either way. Omitting it would hide the answer.
check "the app in the local-apps list, Blender announced"  "$(n "$said" 'data-compute="blender"')" "1"
check "the app in the local-apps list, none announced"     "$(n "$none" 'data-compute="blender"')" "1"
# The two negative reasons differ, because the fixes differ.
r1=$(curl -s -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=comfyui" | python3 -c "import json,sys;print([r for r in json.load(sys.stdin)['regions'] if r['region']=='blender'][0]['reason'][:60])")
r2=$(curl -s -m 30 "$APP_URL/api/v2/capabilities?profile=desktop" | python3 -c "import json,sys;print([r for r in json.load(sys.stdin)['regions'] if r['region']=='blender'][0]['reason'][:60])")
if [ "$r1" != "$r2" ]; then ok "'found none' and 'nothing measured' read differently"; else bad "the two absences give the same reason"; fi
printf '     found none      : %s…\n     never measured  : %s…\n' "$r1" "$r2"

stage "the gate — the region in a real Electron window under xvfb"
timeout 900 node scripts/desktop-run.mjs blender-region 2>&1 | tail -25
[ "${PIPESTATUS[0]}" = "0" ] && ok "blender-region PASSED" || bad "blender-region failed"
REG_RUN="$(newest)"

stage "stage 4 — ⚑ THE CONTROL: no Blender, and the region is ABSENT"
timeout 600 node scripts/desktop-run.mjs blender-absent 2>&1 | tail -18
[ "${PIPESTATUS[0]}" = "0" ] && ok "blender-absent PASSED" || bad "blender-absent failed"
ABS_RUN="$(newest)"

stage "stage 5 — the three readings, re-taken FROM THE SHELL"
# Outside node, outside the app, outside the driver: this repo's Blender, the
# same profile, the probe run from bash. If the app had invented any of these
# the two would disagree.
if [ -n "${REG_RUN:-}" ] && [ -f "$REG_RUN/result.json" ]; then
  APP_VER=$(field "$REG_RUN/result.json" steps.blender.value.version.value)
  APP_MOD=$(field "$REG_RUN/result.json" steps.blender.value.addon.module)
  APP_ADDR=$(field "$REG_RUN/result.json" steps.blender.value.bridge.address)
  GATE_URL=$(field "$REG_RUN/result.json" steps.launch.value.gate.url)
  PROFILE=$(field "$REG_RUN/spec.json" fixtures.bl.profile)
  SHELL_VER=$("$BL" --version 2>/dev/null | sed -n 's/^Blender \([0-9.]*\).*/\1/p' | head -1)
  SHELL_JSON="$WORK/shell-probe.json"
  BLENDER_USER_RESOURCES="$PROFILE" timeout 600 "$BL" --background --python scripts/e5-blender-probe.py 2>/dev/null \
    | sed -n '/^<<<E5_PROBE$/,/^E5_PROBE>>>$/p' | sed '1d;$d' > "$SHELL_JSON"
  SHELL_MOD=$(python3 -c "import json;print(json.load(open('$SHELL_JSON'))['addon_module'])" 2>/dev/null)
  SHELL_ADDR=$(python3 -c "import json;b=json.load(open('$SHELL_JSON'))['bridges'];print(b[0]['addresses'][0]['value'] if b else 'none')" 2>/dev/null)
  printf '   %-28s %-32s %s\n' "" "THE APP SAID" "THE SHELL SEES"
  printf '   %-28s %-32s %s\n' "version" "$APP_VER" "$SHELL_VER"
  printf '   %-28s %-32s %s\n' "addon module" "$APP_MOD" "$SHELL_MOD"
  printf '   %-28s %-32s %s\n' "bridge address" "$APP_ADDR" "$SHELL_ADDR"
  printf '   %-28s %-32s %s\n' "the gate's own port" "$GATE_URL" "(allocated by the kernel)"
  check "the version the app reported is the binary's" "$APP_VER" "$SHELL_VER"
  check "the addon module the app reported is in that profile" "$APP_MOD" "$SHELL_MOD"
  check "the bridge address the app reported is in that profile" "$APP_ADDR" "$SHELL_ADDR"
  check "and it is the address the gate allocated" "$APP_ADDR" "$GATE_URL"
else
  bad "no run directory to re-measure — stage 5 is INCONCLUSIVE"
fi

stage "control A — an unknown host app is REFUSED, never dropped"
check "an id nobody knows" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=blendr")" "400"
check "a known id beside it does not rescue it" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=comfyui,blendr")" "400"
check "the ids that are known" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=comfyui,kohya,blender")" "200"
# An EMPTY announcement is an announcement and must be accepted — it is the
# host saying "I looked and there is nothing", which is not the same answer as
# saying nothing.
check "an empty announcement is accepted" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=")" "200"
check "and it is recorded as honoured" \
  "$(curl -s -m 30 "$APP_URL/api/v2/capabilities?profile=desktop&host_apps=" | python3 -c "import json,sys;print(json.load(sys.stdin)['host_apps']['honoured'])")" "True"
check "while no announcement at all is not" \
  "$(curl -s -m 30 "$APP_URL/api/v2/capabilities?profile=desktop" | python3 -c "import json,sys;print(json.load(sys.stdin)['host_apps']['honoured'])")" "False"

stage "control B — a passing run must NOT satisfy --expect-fail"
timeout 600 node scripts/desktop-run.mjs blender-absent --expect-fail >/dev/null 2>&1
check "--expect-fail on a clean blender-absent" "$?" "1"

stage "control C — the audit sweeps"
timeout 1200 node scripts/desktop-run.mjs blender-absent --audit 2>&1 | tail -6
[ "${PIPESTATUS[0]}" = "0" ] && ok "blender-absent sweep clean" || bad "blender-absent sweep is not clean"
timeout 3000 node scripts/desktop-run.mjs blender-region --audit 2>&1 | tail -11
[ "${PIPESTATUS[0]}" = "0" ] && ok "blender-region sweep clean" || bad "blender-region sweep is not clean"

stage "control D — WO-D5 still passes, and the server's suites are green"
timeout 900 node scripts/desktop-run.mjs dashboard-shape 2>&1 | tail -4
[ "${PIPESTATUS[0]}" = "0" ] && ok "dashboard-shape still passes with a region added to the dashboard" \
  || bad "WO-D5's scenario is red"
# ⚑ Every desktop scenario now loads a dashboard that starts a headless Blender
# (finding E5-6), concurrently with a ComfyUI launch and a generation. The
# heaviest scenario in the repo is the one that would notice.
timeout 900 node scripts/desktop-run.mjs comfy-generate 2>&1 | tail -4
[ "${PIPESTATUS[0]}" = "0" ] && ok "WO-D4's generation still passes beside a Blender probe" \
  || bad "comfy-generate is red"
suite_out=$( cd "$WEB" && SCRUPLE_DB_PATH=$(mktemp -d)/t.db node --import tsx --test test/v2/deployment-shape.test.ts test/v2/canon-theme.test.ts 2>&1 )
suite_rc=$?
printf '%s\n' "$suite_out" | grep -E '^# (tests|pass|fail)'
[ "$suite_rc" = "0" ] && ok "deployment-shape + canon-theme green" || bad "a server suite is red"

printf '\n════ WO-E5 %s ════\n' "$([ $rc = 0 ] && echo 'GATE PASSED' || echo 'GATE FAILED')"
exit $rc
