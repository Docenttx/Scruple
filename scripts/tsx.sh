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

# ⚑ WINDOWS (Git Bash / MSYS). Two conversions are needed and neither is
# cosmetic; without them this script cannot run at all on Windows.
#
#  1. node.exe is a NATIVE Windows binary, so MSYS rewrites POSIX-looking
#     ARGUMENTS on the way to it: /c/SCRUPLEWORK/... arrives as C:/SCRUPLEWORK/...
#     Node's ESM loader then rejects that as a URL with protocol 'c:' --
#     ERR_UNSUPPORTED_ESM_URL_SCHEME, "On Windows, absolute paths must be valid
#     file:// URLs". So --import gets a real file:/// URL. A URL is also immune
#     to the rewriting, because it does not start with '/'.
#
#  2. ENVIRONMENT VARIABLES are NOT rewritten the way arguments are, so
#     NODE_PATH and TSX_TSCONFIG_PATH must be converted explicitly or node.exe
#     receives POSIX paths it cannot resolve.
#
# `cygpath -m` yields C:/like/this -- Windows drive, forward slashes, which both
# node and the file:// form accept. On Linux there is no cygpath and every value
# below is already what node wants.
if command -v cygpath >/dev/null 2>&1; then
  WEB_NATIVE="$(cygpath -m "$WEB")"
  LOADER_URL="file:///$WEB_NATIVE/node_modules/tsx/dist/loader.mjs"
else
  WEB_NATIVE="$WEB"
  LOADER_URL="file://$WEB/node_modules/tsx/dist/loader.mjs"
fi

exec env \
  NODE_PATH="$WEB_NATIVE/node_modules" \
  TSX_TSCONFIG_PATH="$WEB_NATIVE/tsconfig.json" \
  node --import "$LOADER_URL" "$@"
