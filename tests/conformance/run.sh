#!/usr/bin/env bash
# WO-B6 — grade this addon with @scruple/conformance.
#
# Runs from the SERVER repo, not this one. `tsx` resolves from the cwd and
# @scruple/conformance is not published anywhere this addon could install it,
# so the grade runs where the harness lives and reads this repo through
# `git show`. SCRUPLE_ADDON_ROOT is how it knows where "this repo" is.
#
#   tests/conformance/run.sh [--json out.json]
set -euo pipefail
ADDON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
[ -d "$WEB/packages/scruple-conformance" ] || {
  echo "no @scruple/conformance at $WEB — set SCRUPLE_WEB_ROOT" >&2; exit 2; }
cd "$WEB"
exec env SCRUPLE_ADDON_ROOT="$ADDON" SCRUPLE_WEB_ROOT="$WEB" \
  node --import tsx "$ADDON/tests/conformance/grade_blender.ts" "$@"
