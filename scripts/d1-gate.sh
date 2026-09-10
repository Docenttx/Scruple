#!/usr/bin/env bash
# WO-D1 gate, with its controls. One command, non-zero if anything misbehaves.
#
#   the gate     — Electron under xvfb loads the Studio shell and a ping round-trips
#   control A    — the shell's own entry point removed: the run must FAIL
#   control B    — no preload: the ping checks must FAIL (they are not vacuous)
#   control C    — a bridge faking the reply in the renderer must FAIL (the reply
#                  really did come from main)
#
# ⚑ WO-G1 RETIRED THE DEAD-PORT CONTROL, and that is worth saying rather than
# quietly deleting. It fired when the app WAS the served page: kill the server and
# the window has nothing to show. The app is now the Studio shell, loaded off disk,
# and SCRUPLE_APP_URL no longer decides whether it runs — so a dead port stopped
# reddening anything and started PASSING, which is the worst thing a control can
# do. The claim it defended is unchanged ("a window that could not load its page is
# not a running app"), so control A now removes the page it does load. When G2
# embeds a served panel in Workspace, a dead-port control belongs on THAT panel.
#
# Nothing here gates on pixels. docs/DESIGN.md: llvmpipe returns a blank frame.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
rc=0

stage(){ printf '\n════ %s ════\n' "$1"; }

stage "gate — against $APP_URL"
node scripts/d1-ipc-ping.mjs --label gate --url "$APP_URL" || rc=1

# WO-G1. A control app is a COPY of the app under test, with one thing broken.
# It used to be `app/` and package.json, because the app was `app/`. The app is
# now the Studio shell in `app-legacy/`, so a copy without it does not launch —
# and a control that fails because Electron could not find a main script is not a
# control, it is an inconclusive run wearing a green tick. The rails for this
# series say an inconclusive control is never a pass, so the copy has to be whole.
#
# node_modules is SYMLINKED rather than copied: 471 packages, and no control here
# mutates a dependency.
mk_control(){
  local d="$REPO/.run/d1/$1"; rm -rf "$d"; mkdir -p "$d"
  cp -r "$REPO/app" "$d"/
  cp "$REPO/package.json" "$d"/
  mkdir -p "$d/app-legacy"
  ( cd "$REPO/app-legacy" && tar cf - --exclude=node_modules . ) | ( cd "$d/app-legacy" && tar xf - )
  ln -s "$REPO/app-legacy/node_modules" "$d/app-legacy/node_modules"
  ln -s "$REPO/node_modules" "$d/node_modules"
  echo "$d"
}

stage "control A — the shell's own entry point removed (must fail)"
A="$(mk_control noshell)"; rm -f "$A/app-legacy/index-final.html"
node scripts/d1-ipc-ping.mjs --label control-noshell --url "$APP_URL" --app-dir "$A" \
  --timeout 60000 --expect-fail || rc=1


stage "control B — preload removed (ping checks must fail)"
B="$(mk_control nobridge)"; rm -f "$B/app-legacy/preload.js"
node scripts/d1-ipc-ping.mjs --label control-nobridge --url "$APP_URL" --app-dir "$B" --expect-fail || rc=1

stage "control C — bridge fakes the reply in the renderer (must fail)"
C="$(mk_control fakebridge)"
cat > "$C/app-legacy/preload.js" <<'PRELOAD'
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
