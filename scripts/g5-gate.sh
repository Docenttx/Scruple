#!/usr/bin/env bash
# WO-G5 — the no-AI claim, and Standard §4 as the thing that carries it.
#
# THE CLAIM THIS PLUGIN MAKES IS THE OPPOSITE OF STUDIO'S, and that changes
# everything about how it is proved. A signature over an output proves the
# output. Nothing about an output proves what did NOT go into it. Absence is
# carried by the COMPLETENESS OF THE RECORD, so every gap is exactly where the
# AI step could have been.
#
# So this gate does not check that a signature exists. It checks that the claim
# is DERIVED from a record, and — mostly — that it is WITHDRAWN whenever the
# record has a hole:
#
#   1  a complete record claims DIGITAL_CREATION
#   2  installing ANY other add-on withdraws it        · Standard §4
#   3  declared generative material is a FACT, not a gap → COMPOSITE
#   4  the unit refusals: six holes, each one declining
#   5  a plugin NEVER asserts TRAINED_ALGORITHMIC_MEDIA
#
# Nothing here contacts a network. Blender runs headless against a scene this
# script builds.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
SRC="${SCRUPLE_BLENDER_SRC:-/data/scruple-blender}"
RUN="$REPO/.run/g5"
BLENDER="${SCRUPLE_BLENDER_BIN:-$REPO/vendor/blender/bin/blender}"

[ -x "$BLENDER" ] || { echo "!! no Blender at $BLENDER — run npm run e3:install"; exit 2; }
[ -d "$SRC" ] || { echo "!! no add-on source at $SRC"; exit 2; }

rm -rf "$RUN"; mkdir -p "$RUN/home" "$RUN/extra/addons"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m  %-46s %s\n' "$1" "${2:-}"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m  %-46s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
stage(){ printf '\n════ %s ════\n' "$1"; }

# ── the unit refusals ─────────────────────────────────────────────────────────
stage "the six holes, each one declining"
( cd "$SRC" && python3 -m pytest tests/test_source_type.py -q ) > "$RUN/unit.log" 2>&1
if [ $? -eq 0 ]; then
  N=$(grep -oE '[0-9]+ passed' "$RUN/unit.log" | head -1)
  ok "unit-refusals" "$N"
else
  bad "unit-refusals" "see $RUN/unit.log"; tail -5 "$RUN/unit.log"
fi

# ── the live demonstration ────────────────────────────────────────────────────
stage "inside a real Blender"
python3 - "$RUN/texture.png" <<'PY'
import struct, zlib, pathlib, sys
raw = b''.join(b'\x00' + bytes((90, 140, 200)) * 16 for _ in range(16))
def c(t, d):
    b = t + d
    return struct.pack('>I', len(d)) + b + struct.pack('>I', zlib.crc32(b) & 0xffffffff)
pathlib.Path(sys.argv[1]).write_bytes(
    b'\x89PNG\r\n\x1a\n'
    + c(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
    + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b''))
PY

SCRUPLE_BLENDER_SRC="$SRC" \
SCRUPLE_G5_EXTRA_ADDON_DIR="$RUN/extra/addons" \
SCRUPLE_G5_TEXTURE="$RUN/texture.png" \
HOME="$RUN/home" \
timeout 900 "$BLENDER" --background --factory-startup \
  --python "$SRC/tests/live/no_ai_claim_in_blender.py" > "$RUN/blender.log" 2>&1
grep -o '<<<G5>>>.*<<<END>>>' "$RUN/blender.log" | sed 's/<<<G5>>>//;s/<<<END>>>//' > "$RUN/result.json"

if [ ! -s "$RUN/result.json" ]; then
  bad "probe-answered" "no document — see $RUN/blender.log"
  echo; echo "  g5 gate: $pass pass, $((fail)) fail"; exit 1
fi
ok "probe-answered"

check(){ # check <id> <python expr over d> <expected> [note]
  got=$(python3 -c "
import json;d=json.load(open('$RUN/result.json'));print($2)" 2>/dev/null)
  [ "$got" = "$3" ] && ok "$1" "${4:-$got}" || bad "$1" "got [$got] expected [$3]"
}

check probe-ran-clean            "d['ok']"                                          "True"
check the-addon-set-was-hashed   "d['baseline']['unreadable_count']"                "0" \
  "every enabled add-on hashed — cycles is 34MB and used to break this"
check a-complete-record-claims   "d['claim_before']['digital_source_type']"         "DIGITAL_CREATION" \
  "the claim this plugin exists to make"
check the-import-was-enumerated  "d['imported']['source']"                          "host_datablocks"
check the-limit-is-declared      "d['imported']['origin_observed']"                 "False" \
  "nobody watched it arrive, and the claim says so"

# 🔴 STANDARD §4 — THE CONTROL THE WORK ORDER ASKS FOR.
check CONTROL-installing-an-addon-is-seen  "d['change']['added']"                   "['g5_probe_addon']"
check CONTROL-the-baseline-digest-moved    "d['digest_moved']"                      "True"
check CONTROL-the-claim-is-WITHDRAWN       "d['claim_after']['code']"               "addon_set_changed" \
  "§4: changing an integration is itself a witnessed event"
check the-withdrawal-names-what-changed    "d['claim_after']['added']"              "['g5_probe_addon']"

# Declared generative material is a fact, not a hole.
check declared-AI-gives-the-composite-type "d['claim_composite']['digital_source_type']" \
  "COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA"
check the-composite-names-the-datablock    "d['claim_composite']['generative_datablocks']" "['texture.png']"

# 🔴 The one value a plugin must never produce.
NEVER=$(python3 -c "
import json;d=json.load(open('$RUN/result.json'))
bad=[k for k in ('claim_before','claim_after','claim_composite')
     if d[k].get('digital_source_type')=='TRAINED_ALGORITHMIC_MEDIA']
print(','.join(bad) or 'none')")
[ "$NEVER" = "none" ] \
  && ok "CONTROL-never-asserts-trained-algorithmic-media" "Studio's answer is this plugin's opposite" \
  || bad "CONTROL-never-asserts-trained-algorithmic-media" "$NEVER"

# ── the add-on still loads, with the two new buttons on it ───────────────────
stage "the add-on registers"
SCRUPLE_BLENDER_SRC="$SRC" SCRUPLE_G5_BASELINE="$RUN/baseline.json" HOME="$RUN/home" \
  timeout 600 "$BLENDER" --background --factory-startup \
  --python "$SRC/tests/live/claim_operators_in_blender.py" > "$RUN/register.log" 2>&1
grep -o '<<<R>>>.*<<<E>>>' "$RUN/register.log" | sed 's/<<<R>>>//;s/<<<E>>>//' > "$RUN/register.json"
if [ ! -s "$RUN/register.json" ]; then
  bad "addon-registers" "no document — see $RUN/register.log"
else
  rcheck(){ got=$(python3 -c "
import json;d=json.load(open('$RUN/register.json'));print($2)" 2>/dev/null)
    [ "$got" = "$3" ] && ok "$1" "${4:-}" || bad "$1" "got [$got] expected [$3]"; }
  rcheck addon-registers               "d['ok']"                    "True"
  rcheck baseline-operator-exists      "d['has_baseline_addons']"   "True"
  rcheck claim-operator-exists         "d['has_check_claim']"       "True"
  rcheck the-baseline-button-RUNS      "d['baseline_result']"       "['FINISHED']" \
    "an operator that registers and throws is not a button"
  rcheck the-baseline-was-written      "d['baseline_written']"      "True"
  rcheck the-claim-button-RUNS         "d['check_result']"          "['FINISHED']"
  rcheck addon-unregisters-cleanly     "d['unregistered']"          "True" \
    "a register() that cannot be undone breaks the next reload"
fi

echo
echo "  g5 gate: $pass pass, $fail fail"
[ $fail -eq 0 ] || exit 1
