#!/usr/bin/env bash
# WO-D1 gate, with its controls. One command, non-zero if anything misbehaves.
#
#   the gate     — Electron under xvfb loads the served app and a ping round-trips
#   control A    — dead port: the run must FAIL, not report success
#   control B    — no preload: the ping checks must FAIL (they are not vacuous)
#   control C    — a bridge faking the reply in the renderer must FAIL (the reply
#                  really did come from main)
#
# Nothing here gates on pixels. docs/DESIGN.md: llvmpipe returns a blank frame.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
DEAD_PORT="${D1_DEAD_PORT:-39027}"
rc=0

# A dead port must actually be dead, and must not be one Chromium refuses on
# principle — ERR_UNSAFE_PORT would prove nothing about the app.
if curl -s -o /dev/null -m 3 "http://127.0.0.1:$DEAD_PORT/"; then
  echo "!! port $DEAD_PORT is listening; control A needs a dead one (set D1_DEAD_PORT)"; exit 2
fi

stage(){ printf '\n════ %s ════\n' "$1"; }

stage "gate — against $APP_URL"
node scripts/d1-ipc-ping.mjs --label gate --url "$APP_URL" || rc=1

stage "control A — dead port 127.0.0.1:$DEAD_PORT (must fail)"
node scripts/d1-ipc-ping.mjs --label control-deadport --url "http://127.0.0.1:$DEAD_PORT" \
  --timeout 60000 --expect-fail || rc=1

mk_control(){ local d="$REPO/.run/d1/$1"; rm -rf "$d"; mkdir -p "$d"; cp -r "$REPO/app" "$d"/; cp "$REPO/package.json" "$d"/; echo "$d"; }

stage "control B — preload removed (ping checks must fail)"
B="$(mk_control nobridge)"; rm -f "$B/app/preload.js"
node scripts/d1-ipc-ping.mjs --label control-nobridge --url "$APP_URL" --app-dir "$B" --expect-fail || rc=1

stage "control C — bridge fakes the reply in the renderer (must fail)"
C="$(mk_control fakebridge)"
cat > "$C/app/preload.js" <<'PRELOAD'
// CONTROL ONLY: answers in the renderer, never reaches the main process.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('scruple', {
  host: 'electron',
  ping: async (nonce) => ({
    pong: true, echo: nonce, serverNonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
    mainPid: 1, senderWindowId: 1, senderURL: 'http://127.0.0.1:3902/login',
    versions: { electron: 'x', chrome: 'x', node: 'x', v8: 'x' },
  }),
});
PRELOAD
node scripts/d1-ipc-ping.mjs --label control-fakebridge --url "$APP_URL" --app-dir "$C" --expect-fail || rc=1

printf '\n════ WO-D1 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED, all three controls fired' || echo 'NOT PASSED')"
exit $rc
