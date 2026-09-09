#!/usr/bin/env bash
# WO-E6 — fetch the THIRD-PARTY ComfyUI↔Blender bridge, unmodified.
#
# `docs/BLENDER.md`: "We do not fork a bridge, vendor one, or ask users to
# switch." So this downloads what a user downloads — the release zip from the
# project's own GitHub releases — and clones the repository at the SAME TAG for
# the half that installs into ComfyUI, because this bridge ships two halves and
# its README says to install both.
#
#   alexisrolland/ComfyUI-Blender  v3.3.4  — 188 stars, the second-most used of
#   the eleven bridges in docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md,
#   and the one whose architecture is "point a client at a ComfyUI address":
#   no embedded server, no node conversion, an API-format workflow and an
#   address in the add-on's own preferences. WO-E6's report says why this one
#   and what happened to the other candidates.
#
# ⚑ v3.3.4 AND NOT HEAD. HEAD (v4.5.1) declares `"blender": (5, 0, 0)` in
# bl_info; v3.3.4 is the last release of the 4.x line. Neither floor is met by
# the 4.2.23 in this repo's tree — see finding E6-2, which is measured rather
# than assumed.
#
# Everything lands in .run/e6/bridges/, which is gitignored. Nothing here is
# committed, patched or re-exported.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="$PWD/.run/e6/bridges"
TAG="v3.3.4"
ZIP_URL="https://github.com/alexisrolland/ComfyUI-Blender/releases/download/${TAG}/comfyui_blender_${TAG}.zip"
ZIP_SHA="a1492de6b15ba9c7f3b6d7b631dd25fcaa6c590896817f34cdc53798160347cd"
mkdir -p "$DEST"

ZIP="$DEST/comfyui_blender_${TAG}.zip"
if [ ! -f "$ZIP" ]; then
  echo "== downloading $ZIP_URL"
  curl -sSL -o "$ZIP" "$ZIP_URL"
fi
GOT="$(sha256sum "$ZIP" | cut -d' ' -f1)"
if [ "$GOT" != "$ZIP_SHA" ]; then
  echo "REFUSED: $ZIP is $GOT, expected $ZIP_SHA" >&2
  exit 2
fi
echo "== add-on zip   $ZIP  sha256 $GOT (pinned)"

REPO="$DEST/ComfyUI-Blender"
if [ ! -d "$REPO/.git" ]; then
  echo "== cloning the repository for the ComfyUI half"
  git clone --depth 1 --branch "$TAG" -q https://github.com/alexisrolland/ComfyUI-Blender.git "$REPO"
fi
git -C "$REPO" fetch -q --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
git -C "$REPO" checkout -q "$TAG"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
echo "== custom nodes $REPO  at $TAG ($HEAD_SHA)"

# What was installed, so a report can name it rather than describe it.
cat > "$DEST/INSTALLED.json" <<JSON
{
  "bridge": "alexisrolland/ComfyUI-Blender",
  "tag": "$TAG",
  "commit": "$HEAD_SHA",
  "addon_zip": "$ZIP",
  "addon_zip_sha256": "$GOT",
  "custom_nodes_dir": "$REPO",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "unmodified; the zip is the project's own release asset and the clone is at the same tag"
}
JSON
echo "== wrote $DEST/INSTALLED.json"
