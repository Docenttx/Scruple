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

# --json IS RESOLVED HERE, BEFORE THE cd, AND THAT IS THE WHOLE REASON THIS
# LOOP EXISTS. The first version passed "$@" through unchanged and the grade
# ran with cwd=$WEB, so `--json docs/canon/blender-l2/06-conformance-grade.json`
# wrote into the SERVER repo -- a path that exists in both trees, so it landed
# silently and the file read back here was the previous run's.
ARGS=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--json" ] && [ $# -gt 1 ]; then
    case "$2" in
      /*) OUT="$2" ;;
      *)  OUT="$PWD/$2" ;;
    esac
    ARGS+=("--json" "$OUT"); shift 2
  else
    ARGS+=("$1"); shift
  fi
done

cd "$WEB"
exec env SCRUPLE_ADDON_ROOT="$ADDON" SCRUPLE_WEB_ROOT="$WEB" \
  node --import tsx "$ADDON/tests/conformance/grade_blender.ts" "${ARGS[@]}"
