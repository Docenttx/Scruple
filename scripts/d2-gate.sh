#!/usr/bin/env bash
# WO-D2 gate. One command, non-zero if anything misbehaves.
#
#   the gate    — each scenario runs end to end through the real IPC handlers
#                 and passes on its side effects
#   the sweep   — each scenario is broken once per mutation, and each break must
#                 redden EXACTLY the assertions the scenario declared it would
#   control A   — the WO's own: break an assertion on purpose, exit non-zero
#   control B   — the app pointed at a dead port must FAIL, not hang or pass
#   control C   — --expect-fail inverts, so a control that stops failing is
#                 itself a failure
#
# Nothing here reads a log line and nothing reads a pixel (docs/DESIGN.md:
# llvmpipe returns a blank frame).
set -uo pipefail
cd "$(dirname "$0")/.."
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
DEAD_PORT="${D2_DEAD_PORT:-39027}"
rc=0

# The dead port has to be genuinely dead, and not one Chromium refuses on
# principle — ERR_UNSAFE_PORT would prove nothing about the app. (WO-D1 learned
# this the hard way on port 1.)
if curl -s -o /dev/null -m 3 "http://127.0.0.1:$DEAD_PORT/"; then
  echo "!! port $DEAD_PORT is listening; control B needs a dead one (set D2_DEAD_PORT)"; exit 2
fi

stage(){ printf '\n════ %s ════\n' "$1"; }
run(){ echo "\$ node scripts/desktop-run.mjs $*"; node scripts/desktop-run.mjs "$@" || rc=1; }

for s in ping capture-file; do
  stage "gate — scenario $s against $APP_URL"
  run "$s" --url "$APP_URL"
done

for s in ping capture-file; do
  stage "audit sweep — scenario $s broken once per mutation"
  run "$s" --url "$APP_URL" --audit
done

stage "control A — an assertion deliberately broken (must exit non-zero)"
run capture-file --url "$APP_URL" --break assert-expectation --expect-fail

stage "control B — dead port 127.0.0.1:$DEAD_PORT (must exit non-zero)"
run capture-file --url "http://127.0.0.1:$DEAD_PORT" --timeout 90000 --expect-fail

stage "control C — the clean run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs capture-file --url "$APP_URL" --expect-fail >/dev/null 2>&1; then
  echo "   a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-D2 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED, every mutation caught, all three controls fired' || echo 'NOT PASSED')"
exit $rc
