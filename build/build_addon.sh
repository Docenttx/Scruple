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
  lib \
  panels \
  operators \
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
unzip -l "${OUT_DIR}/${ZIP_NAME}" | head -30

if [[ "${1:-}" == "--publish" ]]; then
  echo
  echo "Dry-run: would submit ${OUT_DIR}/${ZIP_NAME} to Blender Extensions."
  echo "Real submission requires a Blender ID and the extensions.blender.org CLI."
  echo "That flow lives outside this script — see docs/developer.md."
fi
