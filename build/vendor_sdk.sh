#!/usr/bin/env bash
#
# Vendor scruple-host-sdk (and the scruple-api it depends on) into
# vendor/, and record where the copy came from.
#
# A Blender addon cannot pip install: Blender ships its own interpreter
# and users install a zip, not a wheel. So the SDK travels inside the
# addon. That is fine -- both packages are pure standard library, so
# vendoring is `cp -r` twice with no resolver -- but a copy with no
# provenance is exactly the thing this product exists to object to.
# Every vendored file's sha256 and the source commit go into
# vendor/VENDOR.json, so any copy can be traced back to the tree it was
# taken from and checked for drift.
#
# Usage:
#   build/vendor_sdk.sh              refresh vendor/ from $SCRUPLE_WEB_ROOT
#   build/vendor_sdk.sh --verify     check vendor/ against its own manifest
#                                    (and against the source tree if present)
#   build/vendor_sdk.sh --if-available
#                                    refresh when the source repo is there,
#                                    verify the committed copy when it is not
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ROOT="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
VENDOR_DIR="$ROOT_DIR/vendor"
MANIFEST="$VENDOR_DIR/VENDOR.json"

PACKAGES=(
  "scruple_api:packages/scruple-api/scruple_api"
  "scruple_host_sdk:packages/scruple-host-sdk/scruple_host_sdk"
)

MODE="${1:---refresh}"

_have_source() {
  [[ -d "$SERVER_ROOT/packages/scruple-host-sdk/scruple_host_sdk" ]]
}

refresh() {
  _have_source || { echo "vendor_sdk: no source at $SERVER_ROOT" >&2; exit 1; }

  local commit dirty
  commit="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
  dirty="false"
  if [[ -n "$(git -C "$SERVER_ROOT" status --porcelain -- packages/scruple-api packages/scruple-host-sdk)" ]]; then
    dirty="true"
  fi

  rm -rf "$VENDOR_DIR"
  mkdir -p "$VENDOR_DIR"

  for spec in "${PACKAGES[@]}"; do
    local name="${spec%%:*}" rel="${spec#*:}"
    rsync -a --exclude '__pycache__' --exclude '*.pyc' \
      "$SERVER_ROOT/$rel/" "$VENDOR_DIR/$name/"
  done

  SCRUPLE_VENDOR_DIR="$VENDOR_DIR" \
  SCRUPLE_SOURCE_ROOT="$SERVER_ROOT" \
  SCRUPLE_SOURCE_COMMIT="$commit" \
  SCRUPLE_SOURCE_DIRTY="$dirty" \
  SCRUPLE_PACKAGES="${PACKAGES[*]}" \
  python3 "$ROOT_DIR/build/write_vendor_manifest.py"

  echo "vendor_sdk: refreshed from $SERVER_ROOT @ ${commit:0:7} (dirty=$dirty)"
}

verify() {
  [[ -f "$MANIFEST" ]] || { echo "vendor_sdk: no $MANIFEST -- run build/vendor_sdk.sh" >&2; exit 1; }
  SCRUPLE_VENDOR_DIR="$VENDOR_DIR" python3 "$ROOT_DIR/build/verify_vendor.py"
}

case "$MODE" in
  --refresh) refresh ;;
  --verify)  verify ;;
  --if-available)
    if _have_source; then refresh; else echo "vendor_sdk: source repo absent; verifying committed copy"; verify; fi
    ;;
  *) echo "usage: build/vendor_sdk.sh [--refresh|--verify|--if-available]" >&2; exit 2 ;;
esac
