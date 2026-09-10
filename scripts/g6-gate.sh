#!/usr/bin/env bash
# WO-G6 — the ways a .blend changes without us seeing it.
#
# 🔴 THIS GATE MUST FIND A HOLE. The work order's control: "at least one case must
# be found that the addon does NOT notice, or the investigation is not finished."
# A survey that concludes "we see everything" has found the limits of its own
# imagination, not the limits of the system. So the assertions below are mostly
# assertions that something is NOT seen — and a run in which everything is seen
# FAILS.
#
#   1  BAT is not an add-on and cannot be in the baseline    · hole 1
#   2  bat pack changes the .blend and NOT its byte count
#   3  ...but every asset digest survives                    · repath, not swap
#   4  a swap against the WITNESSED record is caught         · the must-fire
#   5  the same comparison with nothing touched is quiet     · the must-NOT-fire
#   6  bpy.data.libraries.write fires NO handler             · hole 2
#
# Nothing here contacts a network. Blender runs headless.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
SRC="${SCRUPLE_BLENDER_SRC:-/data/scruple-blender}"
RUN="$REPO/.run/g6"
BLENDER="${SCRUPLE_BLENDER_BIN:-$REPO/vendor/blender/bin/blender}"

[ -x "$BLENDER" ] || { echo "!! no Blender at $BLENDER"; exit 2; }
[ -d "$REPO/vendor/bat/lib/blender_asset_tracer" ] || {
  echo "!! BAT is not unpacked at vendor/bat/lib — run: (cd vendor/bat/lib && unzip -q ../*.whl)"; exit 2; }

rm -rf "$RUN"; mkdir -p "$RUN/assets" "$RUN/proj" "$RUN/home"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m  %-48s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m  %-48s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
stage(){ printf '\n════ %s ════\n' "$1"; }

# ── 1 · BAT is not an add-on ─────────────────────────────────────────────────
stage "hole 1 · the Blender Asset Tracer is not an add-on"
LIB="$REPO/vendor/bat/lib/blender_asset_tracer"
if grep -rq "bl_info" "$LIB" 2>/dev/null; then bad "bat-has-no-bl_info" "it declares bl_info"
else ok "bat-has-no-bl_info" "so no add-on baseline can ever contain it"; fi
if grep -rqE "^\s*(import bpy|from bpy)" "$LIB" 2>/dev/null; then bad "bat-never-imports-bpy"
else ok "bat-never-imports-bpy" "Blender is not running when it edits"; fi

# ── 2-5 · what a pack does, and what a swap does ─────────────────────────────
stage "the pack, and the distinction that survives it"
python3 - "$RUN/assets/wood.png" <<'PY'
import struct, zlib, pathlib, sys
raw = b''.join(b'\x00' + bytes((90, 140, 200)) * 16 for _ in range(16))
def c(t, d):
    b = t + d
    return struct.pack('>I', len(d)) + b + struct.pack('>I', zlib.crc32(b) & 0xffffffff)
pathlib.Path(sys.argv[1]).write_bytes(
    b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
    + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b''))
PY
HOME="$RUN/home" timeout 600 "$BLENDER" --background --factory-startup --python-expr "
import bpy
img = bpy.data.images.load('$RUN/assets/wood.png')
m = bpy.data.materials.new('M'); m.use_nodes = True
m.node_tree.nodes.new('ShaderNodeTexImage').image = img
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.data.materials.append(m)
bpy.ops.wm.save_as_mainfile(filepath='$RUN/proj/shot.blend')
" > "$RUN/build.log" 2>&1
[ -f "$RUN/proj/shot.blend" ] || { bad "test-blend-built" "see $RUN/build.log"; echo; echo "  g6 gate: $pass pass, $((fail)) fail"; exit 1; }
ok "test-blend-built"

RUN="$RUN" node -e '
const Module = require("module"), real = Module._load;
Module._load = (r,p,m) => r === "electron" ? { ipcMain: { handle: (n,f) => { global.__H = f; } } } : real(r,p,m);
require("./app/ipc-bat").registerBatIpc();
(async () => {
  const RUN = process.env.RUN, out = {};
  out.probe = await global.__H(null, { action: "probe" });
  out.witnessed = await global.__H(null, { action: "list", blendPath: RUN + "/proj/shot.blend" });
  out.pack = await global.__H(null, { action: "pack", blendPath: RUN + "/proj/shot.blend", targetDir: RUN + "/packed" });
  out.clean = await global.__H(null, { action: "compare", blendPath: RUN + "/proj/shot.blend",
                                       witnessedAssets: out.witnessed.assets });
  require("fs").writeFileSync(RUN + "/bat.json", JSON.stringify(out));
})();' 2>/dev/null

[ -s "$RUN/bat.json" ] || { bad "bat-channel-answered"; echo; echo "  g6 gate: $pass pass, $((fail)) fail"; exit 1; }
ok "bat-channel-answered"

b(){ node -e "const d=require('$RUN/bat.json');console.log($1)" 2>/dev/null; }
[ "$(b 'd.pack.blend_changed')" = "true" ] && ok "pack-changed-the-blend" || bad "pack-changed-the-blend"
[ "$(b 'd.pack.size_unchanged')" = "true" ] \
  && ok "the-byte-count-did-NOT-move" "🔴 a size check would see nothing" \
  || bad "the-byte-count-did-NOT-move"
[ "$(b 'd.pack.verdict')" = "repath" ] && ok "pack-is-a-repath" || bad "pack-is-a-repath" "$(b 'd.pack.verdict')"
[ "$(b 'd.pack.every_surviving_asset_identical')" = "true" ] \
  && ok "every-asset-survived-byte-identical" "content is separable from location" \
  || bad "every-asset-survived-byte-identical"
[ "$(b 'd.pack.scope')" = "this_operation" ] \
  && ok "the-pack-verdict-declares-its-scope" "it cannot be misread as 'since witnessed'" \
  || bad "the-pack-verdict-declares-its-scope" "$(b 'd.pack.scope')"
[ "$(b 'd.clean.verdict')" = "unchanged" ] \
  && ok "must-NOT-fire-nothing-touched" || bad "must-NOT-fire-nothing-touched" "$(b 'd.clean.verdict')"

# the swap — the must-fire
cp "$RUN/proj/shot.blend" "$RUN/swapped.blend"
python3 - "$RUN/assets/wood.png" <<'PY'
import struct, zlib, pathlib, sys
raw = b''.join(b'\x00' + bytes((220, 40, 40)) * 16 for _ in range(16))
def c(t, d):
    b = t + d
    return struct.pack('>I', len(d)) + b + struct.pack('>I', zlib.crc32(b) & 0xffffffff)
pathlib.Path(sys.argv[1]).write_bytes(
    b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
    + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b''))
PY
RUN="$RUN" node -e '
const Module = require("module"), real = Module._load;
Module._load = (r,p,m) => r === "electron" ? { ipcMain: { handle: (n,f) => { global.__H = f; } } } : real(r,p,m);
require("./app/ipc-bat").registerBatIpc();
(async () => {
  const RUN = process.env.RUN;
  const prior = require(RUN + "/bat.json");
  const r = await global.__H(null, { action: "compare", blendPath: RUN + "/proj/shot.blend",
                                     witnessedAssets: prior.witnessed.assets });
  require("fs").writeFileSync(RUN + "/swap.json", JSON.stringify(r));
})();' 2>/dev/null
s(){ node -e "const d=require('$RUN/swap.json');console.log($1)" 2>/dev/null; }
[ "$(s 'd.verdict')" = "content_changed" ] \
  && ok "MUST-FIRE-a-swap-is-caught" "$(s 'JSON.stringify(d.content_changed)')" \
  || bad "MUST-FIRE-a-swap-is-caught" "$(s 'd.verdict')"
[ "$(s 'd.scope')" = "since_witnessed" ] && ok "the-swap-verdict-declares-its-scope" || bad "the-swap-verdict-declares-its-scope"

# ── 6 · the hole inside Blender ──────────────────────────────────────────────
stage "hole 2 · a write that fires no handler"
rm -rf "$RUN/work"; mkdir -p "$RUN/work"
SCRUPLE_BLENDER_SRC="$SRC" G6_WORK="$RUN/work" HOME="$RUN/home" \
  timeout 700 "$BLENDER" --background --factory-startup \
  --python "$SRC/tests/live/which_handlers_fire.py" > "$RUN/handlers.log" 2>&1
grep -o '<<<H>>>.*<<<E>>>' "$RUN/handlers.log" | sed 's/<<<H>>>//;s/<<<E>>>//' > "$RUN/handlers.json"
if [ ! -s "$RUN/handlers.json" ]; then bad "handler-probe-answered" "see $RUN/handlers.log"; else
  h(){ node -e "const d=require('$RUN/handlers.json');console.log($1)" 2>/dev/null; }
  # ⚑ THE INSTRUMENTATION'S OWN CONTROL. A run that wrapped nothing measured
  # nothing, and its zeros read exactly like "no handler fired".
  W=$(h 'd.wrapped_count')
  [ "${W:-0}" -ge 1 ] && ok "the-probe-wrapped-real-handlers" "$W wrapped" \
                      || bad "the-probe-wrapped-real-handlers" "wrapped $W — this run measured NOTHING"
  [ "$(h 'd.fired.save_from_script.save_post')" = "1" ] \
    && ok "an-ordinary-save-IS-seen" || bad "an-ordinary-save-IS-seen"
  [ "$(h 'd.fired.libraries_write.save_post')" = "0" ] && [ "$(h 'd.libraries_write_produced_a_file')" = "true" ] \
    && ok "HOLE-libraries.write-fires-NOTHING" "🔴 and it produced a file" \
    || bad "HOLE-libraries.write-fires-NOTHING" "it fired — the hole closed, update the report"
  [ "$(h 'JSON.stringify(d.handlers_registered.depsgraph_update_post)')" = "[]" ] \
    && ok "only-saves-are-watched-not-work" "the record is sparse by construction" \
    || bad "only-saves-are-watched-not-work"
fi

echo
echo "  g6 gate: $pass pass, $fail fail"
[ $fail -eq 0 ] || exit 1
