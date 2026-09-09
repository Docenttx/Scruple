#!/usr/bin/env bash
# Run a TypeScript file against the server repo's toolchain.
#
# The desktop repo has no TypeScript build of its own and should not grow one:
# every type it needs is defined in /data/scruple-web, and a second tsconfig
# would be a second answer to what `@/lib/...` means. So this wrapper points
# node at the server repo's tsx and its tsconfig, and nothing else.
#
#   NODE_PATH          so `require('ws')` etc. inside the SDK resolves
#   TSX_TSCONFIG_PATH  so the `@/*` path alias resolves. Without it the import
#                      chain dies at lib/leaf/hashes.ts with MODULE_NOT_FOUND.
set -euo pipefail
WEB="${SCRUPLE_WEB_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../vendor/scruple-web" && pwd -P)}"
exec env \
  NODE_PATH="$WEB/node_modules" \
  TSX_TSCONFIG_PATH="$WEB/tsconfig.json" \
  node --import "$WEB/node_modules/tsx/dist/loader.mjs" "$@"
