#!/usr/bin/env bash
#
# Package the addon as scruple-blender-<version>.zip in Blender
# Extensions format. The output is drop-in for both the modern
# Extensions system (4.2+) and the legacy classic-addon flow (3.x/4.0/4.1).
#
# Usage:
#   build/build_addon.sh            → produce dist/scruple-blender-<v>.zip
#   build/build_addon.sh --publish  → dry-run the Extensions submission
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(cat VERSION | tr -d '[:space:]')"
STAGE_NAME="scruple_blender"
STAGE_DIR="build/artifacts/${STAGE_NAME}"
OUT_DIR="dist"
ZIP_NAME="scruple-blender-${VERSION}.zip"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

# The SDK travels inside the zip. Blender ships its own interpreter and
# users install an archive, not a wheel -- there is no pip step in which
# `scruple-host-sdk` could be resolved. Refresh the vendored copy from
# the source repo when it is on this machine, verify the committed copy
# when it is not, and abort either way if vendor/ no longer matches its
# own manifest. vendor/VENDOR.json carries the source commit and a
# sha256 per file, so a zip in a user's hands can be traced back to the
# tree it was cut from.
build/vendor_sdk.sh --if-available

# The Extensions system expects the addon at the top of the zip, in a
# folder whose name matches the manifest id. We stage into that folder
# and zip it so the archive expands cleanly under
# scripts/addons_core/scruple_blender/ inside Blender.
rsync -a \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'tests' \
  --exclude 'build' \
  --exclude 'dist' \
  --exclude 'docs' \
  --exclude '.git' \
  --exclude '.pytest_cache' \
  --exclude 'SESSION_REPORT_*.md' \
  __init__.py \
  blender_manifest.toml \
  README.md \
  LICENSE \
  VERSION \
  adapter \
  panels \
  operators \
  vendor \
  "$STAGE_DIR/"

# Compile-check every .py so a syntax error trips the packager, not the user.
python3 -m compileall -q "$STAGE_DIR" || {
  echo "compileall found errors; aborting"
  exit 1
}

# Sweep the __pycache__ that compileall created back out.
find "$STAGE_DIR" -type d -name __pycache__ -exec rm -rf {} +

pushd "$(dirname "$STAGE_DIR")" >/dev/null
rm -f "../../${OUT_DIR}/${ZIP_NAME}"
zip -qr "../../${OUT_DIR}/${ZIP_NAME}" "$(basename "$STAGE_DIR")"
popd >/dev/null

echo "Built: ${OUT_DIR}/${ZIP_NAME}"
echo "Vendored SDK: $(python3 -c 'import json;m=json.load(open("vendor/VENDOR.json"));print(m["source_repo"], m["source_commit"][:12], "dirty" if m["source_tree_dirty_at_copy"] else "clean", len(m["files"]), "files")')"
unzip -l "${OUT_DIR}/${ZIP_NAME}" | head -40

if [[ "${1:-}" == "--publish" ]]; then
  echo
  echo "Dry-run: would submit ${OUT_DIR}/${ZIP_NAME} to Blender Extensions."
  echo "Real submission requires a Blender ID and the extensions.blender.org CLI."
  echo "That flow lives outside this script — see docs/developer.md."
fi
