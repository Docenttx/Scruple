#!/usr/bin/env bash
# scruple-nodes sync-upstream — fetch each fork's upstream and rebase
# the scruple-canvas-fork branch on top.
#
# Usage:
#   bash external/scruple-nodes/sync-upstream.sh [node-name]
#
# Without arguments: syncs every fork.
# With one argument: syncs just that fork.
#
# This script is non-destructive on conflicts — if the rebase fails,
# the working tree is left in a rebase-in-progress state and the
# script exits non-zero. Resolve by hand:
#   cd external/scruple-nodes/<name>
#   git rebase --continue   (or --abort)
#
# After a successful run, restart ComfyUI to pick up canvas changes:
#   sudo systemctl restart comfyui.service
# And re-deploy Modal to pick up runner changes:
#   modal deploy modal/scruple_runner.py

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

sync_one() {
  local node="$1"
  local dir="$ROOT/$node"
  if [[ ! -d "$dir/.git" ]]; then
    echo "  ✗ $node: not a git repo at $dir — skipping"
    return 0
  fi
  cd "$dir"
  if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "  ✗ $node: no 'upstream' remote configured — skipping"
    cd "$ROOT"
    return 0
  fi
  echo "→ $node"
  git fetch upstream --quiet
  local up_branch
  up_branch="$(git remote show upstream | awk '/HEAD branch/ {print $NF}')"
  echo "  upstream HEAD: $up_branch"
  git checkout upstream-vendored --quiet
  if ! git merge --ff-only "upstream/$up_branch" --quiet 2>&1; then
    echo "  ✗ upstream-vendored isn't a strict ancestor — manual intervention"
    cd "$ROOT"
    return 0
  fi
  git checkout scruple-canvas-fork --quiet
  if git rebase upstream-vendored --quiet 2>&1; then
    echo "  ✓ rebased onto upstream-vendored"
  else
    echo "  ✗ rebase conflict; resolve in $dir"
    cd "$ROOT"
    return 0
  fi
  cd "$ROOT"
}

if [[ $# -ge 1 ]]; then
  sync_one "$1"
else
  for d in */; do
    name="${d%/}"
    # Skip the _upstream-snapshots archive dir
    [[ "$name" == _* ]] && continue
    sync_one "$name"
  done
fi
