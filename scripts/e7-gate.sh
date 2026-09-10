#!/usr/bin/env bash
# WO-E7 — THE TWO PRODUCTS, MIRRORED, AND THE HONEST DIFFERENCE BETWEEN THEM.
#
#   npm run e7      (bash scripts/e7-gate.sh)
#
# The work order: "Put a leaf from each next to the others and state exactly
# which fields differ and why… the three leaves differ only in the fields the
# table in docs/BLENDER.md predicts, and no two of them read the same where
# they should differ."
#
#   A  THE ADD-ON ALONE      /data/scruple-blender, signed in against the
#                            scratch app, no gate anywhere in the path.
#   B  DESKTOP STUDIO ALONE  the gate in the path, nobody registered on the
#                            hook. WO-D4's own scenario, unchanged.
#   C  BOTH                  WO-E6's run: a third-party bridge inside Blender
#                            pointed at the gate, and the add-on announcing.
#
# ⚑ THE SCENE A IS BUILT AROUND CONTAINS AN AI OUTPUT. A1 imports the artifact
# C generated and A2 imports the artifact B generated — the same scene, the
# same camera, the same frame, the same filenames, and a different image that
# came out of a ComfyUI graph the add-on never saw. Whether the add-on's leaf
# moves is the work order's flagged question and stage 6 measures it.
#
# 🔴 Rails: scratch witness 5899, scratch app 3902, surrogate 8799. Nothing
# here contacts :5799 or :3001. Every leaf B and C produce is `stale`.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
RUN="$REPO/.run/e7"; mkdir -p "$RUN"
DB="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
WDB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
APP="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
BLENDER="$REPO/vendor/blender/bin/blender"
ZIP="${E7_ZIP:-/data/scruple-blender/dist/scruple-blender-0.1.0.zip}"
PROFILE="$RUN/blender-profile"
NONCE="$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-64s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-64s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
differs(){ if [ "$2" != "$3" ]; then printf '   ok    %-64s %s ≠ %s\n' "$1" "${2:0:20}" "${3:0:20}"; ok=$((ok+1));
         else printf '   FAIL  %-64s both %s\n' "$1" "${2:0:24}"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-64s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }
q(){ sqlite3 "file:$DB?mode=ro" -batch "$1"; }
jq_(){ python3 -c "import json,sys;d=json.load(open(sys.argv[1]));
v=d
for k in sys.argv[2].split('.'):
    v = v[int(k)] if k.isdigit() else v[k]
print(v if v is not None else '')" "$1" "$2"; }

[ -x "$BLENDER" ] || { echo "!! no Blender at $BLENDER — run scripts/e3-install-blender.sh"; exit 2; }
[ -f "$ZIP" ]     || { echo "!! no addon zip at $ZIP — run build/build_addon.sh in the addon repo"; exit 2; }
[ -f "$RUN/../e6/bridges/INSTALLED.json" ] || { echo "!! run scripts/e6-install-bridge.sh first"; exit 2; }

note "STAGE 0 — what is under test, named rather than described"
echo "   blender      $("$BLENDER" --version 2>/dev/null | head -1)"
echo "   scruple zip  $(sha256sum "$ZIP" | cut -c1-64)"
echo "   bridge       $(python3 -c "import json;d=json.load(open('$RUN/../e6/bridges/INSTALLED.json'));print(d['bridge'],d['tag'],d['addon_zip_sha256'][:16])")"
echo "   nonce        $NONCE"
WATERMARK="$(q 'SELECT COALESCE(MAX(id),0) FROM iterations;')"
echo "   iterations watermark before this gate: $WATERMARK"

# The add-on's own profile and its own key. Two products, two tenants.
#
# ⚑ WO-F1: the profile is rebuilt when the SHIPPED ZIP CHANGES, not only when it
# is missing. This gate used to reuse whatever was installed, so a run after an
# add-on change silently measured the previous build — which is how a gate ends
# up green about code nobody is shipping. The stamp is the zip's digest.
ZIP_SHA="$(sha256sum "$ZIP" | cut -d" " -f1)"
if [ ! -d "$PROFILE/extensions/user_default/scruple_blender" ] \
   || [ "$(cat "$PROFILE/.installed-zip-sha256" 2>/dev/null)" != "$ZIP_SHA" ]; then
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  BLENDER_USER_RESOURCES="$PROFILE" timeout 600 "$BLENDER" --command extension install-file \
    -r user_default -e "$ZIP" > "$RUN/install.log" 2>&1
  echo "$ZIP_SHA" > "$PROFILE/.installed-zip-sha256"
fi
[ -d "$PROFILE/extensions/user_default/scruple_blender" ] && INST=yes || INST=no
check "the add-on is installed in its own profile, through the manifest path" "yes" "$INST"
ADDON_KEY="$(bash scripts/tsx.sh scripts/e7-addon-key.ts --print-key)"
[ -n "$ADDON_KEY" ] && KEYOK=yes || KEYOK=no
check "the add-on has an API key of its own" "yes" "$KEYOK"

note "STAGE 1 — ⚑ THE CONTROL, RED BEFORE THE CHANGE"
# E7 changes no application code — it is the close-out — so the honest form of
# "red before" is: the tree at the parent of the commit that adds these scripts
# CANNOT PRODUCE LEAF A AND CANNOT COMPARE ANYTHING. Resolved from the change
# and not from HEAD, the WO-E6 way.
ADDED="$(git log --diff-filter=A --format=%H -1 -- scripts/e7-addon-alone.py)"
if [ -z "$ADDED" ]; then
  incon "stage 1 runs after the commit that adds scripts/e7-addon-alone.py" "not committed yet"
else
  BEFORE="$(git rev-parse "$ADDED^")"
  WT="$RUN/before-tree"; rm -rf "$WT"; git worktree remove --force "$WT" 2>/dev/null || true
  git worktree add -q --detach "$WT" "$BEFORE"
  echo "   at $BEFORE (parent of $ADDED)"
  [ -f "$WT/scripts/e7-addon-alone.py" ] && HASA=yes || HASA=no
  [ -f "$WT/scripts/e7-leaf-diff.py" ]   && HASD=yes || HASD=no
  check "the before-tree cannot run the add-on alone (no e7-addon-alone.py)" "no" "$HASA"
  check "…and cannot compare three leaves (no e7-leaf-diff.py)"             "no" "$HASD"
  git worktree remove --force "$WT" 2>/dev/null || true
fi
# The control that matters more, and it runs on real data at stage 8: the
# comparator fed the same leaf twice must go red.

note "STAGE 1B — ⚑ E7-2: does the add-on's own Settings UI bind on the path it ships on?"
# The same zip, the same Blender 4.2.23, TWO INSTALL PATHS. `AddonPreferences`
# is matched to an add-on by `bl_idname == the module Blender enabled it under`,
# and the add-on hardcodes the legacy module name. This is the control: if the
# preferences bound on both paths there would be no finding, and if they bound
# on neither the cause would be something else.
LEGACY_PROFILE="$RUN/legacy-profile"
if [ ! -d "$LEGACY_PROFILE/scripts/addons/scruple_blender" ] \
   || [ "$(cat "$LEGACY_PROFILE/.installed-zip-sha256" 2>/dev/null)" != "$ZIP_SHA" ]; then
  rm -rf "$LEGACY_PROFILE"; mkdir -p "$LEGACY_PROFILE/scripts/addons"
  unzip -q "$ZIP" -d "$LEGACY_PROFILE/scripts/addons"
  echo "$ZIP_SHA" > "$LEGACY_PROFILE/.installed-zip-sha256"
fi
prefs_probe(){ # prefs_probe <profile> [enable-module]
  BLENDER_USER_RESOURCES="$1" timeout 900 "$BLENDER" --background \
    --python "$REPO/scripts/e7-prefs-probe.py" -- ${2:+--enable "$2"} 2>&1 \
    | sed -n '/<<<E7_PREFS/,/E7_PREFS>>>/p' | sed '1d;$d'
}
prefs_probe "$PROFILE" > "$RUN/prefs-manifest.json"
prefs_probe "$LEGACY_PROFILE" scruple_blender > "$RUN/prefs-legacy.json"
bound(){ python3 -c "import json,sys;d=json.load(open('$1'));print(d['enabled'][0]['preferences_bound'] if d['enabled'] else 'NO-ADDON')"; }
modof(){ python3 -c "import json;d=json.load(open('$1'));print(d['enabled'][0]['module'] if d['enabled'] else '-')"; }
echo "   manifest path  module $(modof "$RUN/prefs-manifest.json")"
echo "   legacy path    module $(modof "$RUN/prefs-legacy.json")"
echo "   bl_idname      $(python3 -c "import json;print(json.load(open('$RUN/prefs-legacy.json'))['bl_idname'])")"
# ⚑ CLOSED BY WO-F1 (add-on `29962b8`), and these four checks were flipped to
# assert the closure rather than the defect. Leaving them asserting the defect
# would have made this gate go red for the reason it was written to prevent —
# and, worse, would have made "the base URL falls back to production" a thing
# the estate's own suite required to stay true. The red-before evidence is not
# lost: `scripts/f1-gate.sh` rebuilds the zip from the parent commit and shows
# every one of these red, then green, in one run. `docs/WO-F1.md`.
check "the LEGACY path binds the Settings UI (so the class is fine)" "True" "$(bound "$RUN/prefs-legacy.json")"
check "⚑ the MANIFEST path — the one a 4.2+ user gets — binds it too now" "True" "$(bound "$RUN/prefs-manifest.json")"
check "…so there IS somewhere to paste an API key on the shipping path" "True" \
  "$(python3 -c "import json;print(json.load(open('$RUN/prefs-manifest.json'))['enabled'][0]['api_key_settable'])")"
UNCONF_E7="$(python3 -c "import json;print(json.load(open('$RUN/prefs-manifest.json'))['base_url_with_no_prefs_and_no_cache'])")"
check "…and with nothing configured the base URL is NOT production" "<empty>" \
  "$([ -z "$UNCONF_E7" ] && echo "<empty>" || echo "$UNCONF_E7")"

note "STAGE 1C — ⚑ E7-3: the add-on's in-memory worker drops queued captures on stop()"
python3 scripts/e7-worker-stop-probe.py > "$RUN/worker-stop.json" 2>&1
WS_EXIT=$?
sed 's/^/   /' "$RUN/worker-stop.json"
check "a capture still queued when stop() is called does not run" "0" "$WS_EXIT"

note "STAGE 2 — C: BOTH. The WO-E6 run, unchanged."
timeout 2400 node scripts/desktop-run.mjs blender-generate --timeout 900000 > "$RUN/run-c.log" 2>&1
C_EXIT=$?
check "the blender-generate scenario passed" "0" "$C_EXIT"
C_DIR="$(ls -td "$REPO"/.run/d2/clean-* | head -1)"
C_HASH="$(jq_ "$C_DIR/result.json" 'steps.gen.value.images.0.sha256')"
C_PATH="$(jq_ "$C_DIR/result.json" 'steps.gen.value.images.0.storePath')"
C_LEAF="$(q "SELECT id FROM iterations WHERE output_hash='$C_HASH' AND id>$WATERMARK ORDER BY id DESC LIMIT 1;")"
echo "   artifact $C_HASH"
echo "   leaf     $C_LEAF  ($(q "SELECT COUNT(*) FROM iterations WHERE output_hash='$C_HASH' AND id>$WATERMARK;") leaves for these bytes — E6-4)"
[ -n "$C_LEAF" ] && CL=yes || CL=no
check "C produced a leaf in this gate's window" "yes" "$CL"
check "…and it says the meaning was supplied" "supplied" "$(q "SELECT host_semantics FROM iterations WHERE id=$C_LEAF;")"

note "STAGE 3 — B: DESKTOP STUDIO ALONE. WO-D4's scenario, no host fixture."
timeout 1800 node scripts/desktop-run.mjs comfy-generate --timeout 900000 > "$RUN/run-b.log" 2>&1
B_EXIT=$?
check "the comfy-generate scenario passed" "0" "$B_EXIT"
B_DIR="$(ls -td "$REPO"/.run/d2/clean-* | head -1)"
B_HASH="$(jq_ "$B_DIR/result.json" 'steps.gen.value.images.0.sha256')"
B_PATH="$(jq_ "$B_DIR/result.json" 'steps.gen.value.images.0.storePath')"
B_LEAF="$(q "SELECT id FROM iterations WHERE output_hash='$B_HASH' AND id>$WATERMARK ORDER BY id DESC LIMIT 1;")"
echo "   artifact $B_HASH"
echo "   leaf     $B_LEAF"
[ -n "$B_LEAF" ] && BL=yes || BL=no
check "B produced a leaf in this gate's window" "yes" "$BL"
check "…and it DECLARES its blindness" "blind" "$(q "SELECT host_semantics FROM iterations WHERE id=$B_LEAF;")"
differs "the two generations produced different bytes" "$B_HASH" "$C_HASH"

# ---- the add-on alone, twice, with two different AI images -----------------
addon_run(){ # addon_run <label> <image> <outvar-prefix>
  local label="$1" image="$2" w="$RUN/$1"
  rm -rf "$w"; mkdir -p "$w/home"
  cp "$image" "$w/imported.png"
  # ⚑ SCRUPLE_COMFY_HOST_DIR IS UNSET AND HOME IS MOVED. The first keeps a gate
  # out of this run (the add-on writes a declaration only when it is set); the
  # second keeps the key cache out of the real ~/.scruple.
  env -u SCRUPLE_COMFY_HOST_DIR HOME="$w/home" BLENDER_USER_RESOURCES="$PROFILE" \
    timeout 1200 "$BLENDER" --background --python "$REPO/scripts/e7-addon-alone.py" -- \
      --api-key "$ADDON_KEY" --base-url "$APP" --work "$w" --import-image "$w/imported.png" \
      --scene "atrium-$NONCE" --camera CAM_hero --frame 173 \
      > "$w/blender.log" 2>&1
  python3 - "$w/blender.log" "$w/report.json" <<'PY'
import json,re,sys
t=open(sys.argv[1], errors="replace").read()
m=re.search(r'<<<E7_ADDON\n(.*?)\nE7_ADDON>>>', t, re.S)
if not m:
    sys.stderr.write(t[-3000:]); raise SystemExit("no report from Blender")
json.dump(json.loads(m.group(1)), open(sys.argv[2],'w'), indent=1)
PY
}

note "STAGE 4 — A1: THE ADD-ON ALONE, on a scene built around C's AI output"
addon_run a1 "$C_PATH"
A1="$RUN/a1/report.json"
[ -f "$A1" ] && A1OK=yes || A1OK=no
check "Blender reported" "yes" "$A1OK"
check "⚑ no gate was in this run (SCRUPLE_COMFY_HOST_DIR unset)" "" "$(jq_ "$A1" host_dir_env)"
check "the add-on loaded through the manifest path" "True" "$(jq_ "$A1" loaded_via_manifest)"
check "it talked to the server directly" "$APP" "$(jq_ "$A1" base_url)"
check "the AI image is PACKED into the .blend it witnessed" "True" "$(jq_ "$A1" imported_image.packed)"
echo "   captures: $(jq_ "$A1" captures_before_stop) before stop, $(jq_ "$A1" captures_after_stop) after"

note "STAGE 5 — A2: THE SAME SCENE, a DIFFERENT AI output (B's)"
addon_run a2 "$B_PATH"
A2="$RUN/a2/report.json"
[ -f "$A2" ] && A2OK=yes || A2OK=no
check "Blender reported" "yes" "$A2OK"

note "STAGE 6 — ⚑ ROW 1: what the add-on committed to, as a document"
python3 scripts/e7-addon-graph.py --report "$A1"
python3 scripts/e7-addon-graph.py --report "$A1" --json > "$RUN/a1-graphs.json"
python3 scripts/e7-addon-graph.py --report "$A2" --json > "$RUN/a2-graphs.json"

# The leaf under comparison is chosen by the ADD-ON'S OWN RECEIPT — the leaf id
# the server handed back, recorded in its assurance record — and then CHECKED
# against the graph rebuilt outside Blender. Picking "the newest row" would
# work by luck; picking by workflow_hash alone cannot work here at all, because
# A1 and A2 deliberately produce the SAME graph.
leaf_of(){ # leaf_of <report.json> <graphs.json> <trigger>
  python3 "$REPO/scripts/e7-leaf-of.py" "$1" "$2" "$3"
}
A_LEAF="$(leaf_of "$A1" "$RUN/a1-graphs.json" render_write)"
A2_LEAF="$(leaf_of "$A2" "$RUN/a2-graphs.json" render_write)"
A1_WF="$(python3 -c "import json;print(json.load(open('$RUN/a1-graphs.json'))['render_write']['workflow_hash'])")"
[ -n "$A_LEAF" ] && AL=yes || AL=no
check "the add-on's own receipt names a leaf for the render" "yes" "$AL"
echo "   leaf A   $A_LEAF   leaf A2  $A2_LEAF"
check "⚑ the graph rebuilt OUTSIDE Blender is the graph ON that leaf" "$A1_WF" "$(q "SELECT workflow_hash FROM iterations WHERE id=$A_LEAF;")"

# ⚑ AND BOTH RENDER HANDLERS LANDED A LEAF — finding E7-4. `render_write` and
# `render_complete` each witness the same file, with two different graphs.
A1_WF_C="$(python3 -c "import json;print(json.load(open('$RUN/a1-graphs.json'))['render_complete']['workflow_hash'])")"
A1_WF_S="$(python3 -c "import json;print(json.load(open('$RUN/a1-graphs.json'))['save_post']['workflow_hash'])")"
# ⚑ CONSTRAINED BY THE BYTES, NOT JUST BY THE GRAPH. The first version of these
# two counted rows by `workflow_hash` alone and got 2 where it expected 1 — and
# it was the assertion that was wrong, not the system: A1 and A2 are built to
# produce the SAME graph, so both runs' leaves match. Which is itself the row-1
# result arriving early. Pinned to A1's own output bytes.
A1_BLEND_H="$(sha256sum "$(jq_ "$A1" blend_path)" | cut -d' ' -f1)"
A1_RENDER_H="$(sha256sum "$(jq_ "$A1" render_path)" | cut -d' ' -f1)"
check "⚑ the OTHER render handler landed its own leaf for the same file" "1" \
  "$(q "SELECT COUNT(*) FROM iterations WHERE workflow_hash='$A1_WF_C' AND output_hash='$A1_RENDER_H' AND id>$WATERMARK;")"
check "…and the .blend it saved has one too, with the AI image packed in it" "1" \
  "$(q "SELECT COUNT(*) FROM iterations WHERE workflow_hash='$A1_WF_S' AND output_hash='$A1_BLEND_H' AND id>$WATERMARK;")"

A1_OUT="$(jq_ "$A1" render_path)"; A2_OUT="$(jq_ "$A2" render_path)"
A1_PIX="$(sha256sum "$A1_OUT" | cut -d' ' -f1)"
A2_PIX="$(sha256sum "$A2_OUT" | cut -d' ' -f1)"
echo "   A1 pixels $A1_PIX   (from C's AI output)"
echo "   A2 pixels $A2_PIX   (from B's AI output)"
if [ "$A1_PIX" = "$A2_PIX" ]; then
  incon "the two renders are byte-identical, so the invariance measurement says nothing" "$A1_PIX"
else
  differs "the two runs rendered DIFFERENT pixels — two different AI images" "$A1_PIX" "$A2_PIX"
  check "the leaf's output_hash follows the pixels" "$A1_PIX" "$(q "SELECT output_hash FROM iterations WHERE id=$A_LEAF;")"
  # ⚑ THE MEASUREMENT THE WORK ORDER FLAGS. Same scene, same camera, same
  # frame, same filenames, a different AI image inside. If the add-on's leaf
  # implied ANYTHING about the AI step, something here would have to move.
  for col in workflow_hash model_fingerprints model_fingerprints_hash input_hash \
             input_artifacts host host_semantics host_evidence machine_manifest_hash \
             leaf_scheme canonicalization_profile leaf_kind; do
    V1="$(q "SELECT COALESCE($col,'(null)') FROM iterations WHERE id=$A_LEAF;")"
    V2="$(q "SELECT COALESCE($col,'(null)') FROM iterations WHERE id=$A2_LEAF;")"
    check "⚑ $col is IDENTICAL for two different AI images" "$V1" "$V2"
  done
fi
NKEYS="$(python3 -c "import json;print(len(json.load(open('$RUN/a1-graphs.json'))['render_write']['graph']))")"
MENTIONS="$(python3 "$REPO/scripts/e7-graph-mentions.py" "$RUN/a1-graphs.json" "$A1")"
echo "   the render graph has $NKEYS keys"
check "⚑ none of them mentions the image that was imported" "0" "$MENTIONS"

note "STAGE 7 — THE THREE LEAVES, EVERY COLUMN CLASSIFIED"
python3 scripts/e7-leaf-diff.py --a "$A_LEAF" --b "$B_LEAF" --c "$C_LEAF" > "$RUN/diff.txt" 2>&1
DIFF_EXIT=$?
sed -n '/THE AXES/,/^══ MUST AGREE/p' "$RUN/diff.txt" | head -60
sed -n '/WHICH PRODUCT/,$p' "$RUN/diff.txt"
check "the three-way comparison passed (full transcript in .run/e7/diff.txt)" "0" "$DIFF_EXIT"

note "STAGE 8 — THE CONTROLS"
echo "   ── control 1: the comparator can fail (A replaced by a copy of B)"
python3 scripts/e7-leaf-diff.py --a "$A_LEAF" --b "$B_LEAF" --c "$C_LEAF" --self-control > "$RUN/self-control.txt" 2>&1
SC_EXIT=$?
REDS="$(grep -c '      RED  ' "$RUN/self-control.txt" || true)"
echo "      $REDS checks went red"
check "the comparator noticed that A and B were the same leaf" "0" "$SC_EXIT"
[ "$REDS" -ge 20 ] && MANY=yes || MANY=no
check "…on the columns that are supposed to distinguish them" "yes" "$MANY"

echo "   ── control 2: model_fingerprints_hash reads the WEIGHTS, not the filename"
timeout 1800 node scripts/desktop-run.mjs comfy-generate --break model-swap --expect-fail --timeout 900000 \
  > "$RUN/control-model-swap.log" 2>&1
MS_DIR="$(ls -td "$REPO"/.run/d2/break-model-swap-* | head -1)"
MS_HASH="$(jq_ "$MS_DIR/result.json" 'steps.gen.value.images.0.sha256' 2>/dev/null || echo '')"
if [ -z "$MS_HASH" ]; then
  incon "the model-swap run produced no artifact to read" "-"
else
  MS_FP="$(q "SELECT model_fingerprints_hash FROM iterations WHERE output_hash='$MS_HASH' ORDER BY id DESC LIMIT 1;")"
  B_FP="$(q "SELECT model_fingerprints_hash FROM iterations WHERE id=$B_LEAF;")"
  differs "swapping the weights MOVES the fingerprint on B's own leaf" "$B_FP" "$MS_FP"
  check "…and A still has none, because the add-on never saw any weights" "" "$(q "SELECT COALESCE(model_fingerprints_hash,'') FROM iterations WHERE id=$A_LEAF;")"
fi

echo "   ── control 3: host_semantics reads the ANNOUNCEMENT"
timeout 2400 node scripts/desktop-run.mjs blender-generate --break blender-does-not-announce --expect-fail --timeout 900000 \
  > "$RUN/control-no-announce.log" 2>&1
NA_DIR="$(ls -td "$REPO"/.run/d2/break-blender-does-not-announce-* | head -1)"
NA_HASH="$(jq_ "$NA_DIR/result.json" 'steps.gen.value.images.0.sha256' 2>/dev/null || echo '')"
if [ -z "$NA_HASH" ]; then
  incon "the silent-add-on run produced no artifact to read" "-"
else
  NA_SEM="$(q "SELECT host_semantics FROM iterations WHERE output_hash='$NA_HASH' ORDER BY id DESC LIMIT 1;")"
  check "with the add-on silent, C's leaf stops saying supplied" "declined" "$NA_SEM"
  check "…and B's blind is unmoved, because B has no add-on to silence" "blind" "$(q "SELECT host_semantics FROM iterations WHERE id=$B_LEAF;")"
  check "…and A still says NOTHING AT ALL — not blind, not declined" "" "$(q "SELECT COALESCE(host_semantics,'') FROM iterations WHERE id=$A_LEAF;")"
fi

note "STAGE 9 — FROM THE SHELL: the bytes and the witness's own file"
for pair in "A:$A_LEAF:$A1_OUT" "B:$B_LEAF:$B_PATH" "C:$C_LEAF:$C_PATH"; do
  L="${pair#*:}"; LEAF="${L%%:*}"; P="${L#*:}"
  H="$(sha256sum "$P" | cut -d' ' -f1)"
  check "${pair%%:*}: sha256sum of the bytes on disk is the leaf's output_hash" \
    "$(q "SELECT output_hash FROM iterations WHERE id=$LEAF;")" "$H"
  W="$(sqlite3 "file:$WDB?mode=ro" -batch "SELECT COUNT(*) FROM witnesses WHERE content_hash='$H';")"
  [ "$W" -ge 1 ] && WOK=yes || WOK=no
  check "${pair%%:*}: the witness's own sqlite file holds a leaf for them" "yes" "$WOK"
done
echo
echo "   THE THREE LEAVES, printed:"
q "SELECT id, leaf_kind, leaf_scheme, substr(workflow_hash,1,12), COALESCE(substr(model_fingerprints_hash,1,12),'(null)'), COALESCE(host,'(null)'), COALESCE(host_semantics,'(NULL)'), COALESCE(attestation_basis,'(null)') FROM iterations WHERE id IN ($A_LEAF,$B_LEAF,$C_LEAF) ORDER BY id;" | sed 's/^/   /'
check "🔴 no leaf in this gate claims verified" "0" "$(q "SELECT COUNT(*) FROM iterations WHERE id>$WATERMARK AND attestation_basis='verified';")"

note "STAGE 10 — the suites that must not go red"
timeout 1800 node scripts/desktop-run.mjs blender-host --timeout 900000 > "$RUN/regress-e4.log" 2>&1
check "WO-E4's blender-host scenario still passes" "0" "$?"
( cd /data/scruple-blender && timeout 1800 python3 -m pytest -q tests > "$RUN/regress-addon.log" 2>&1 )
check "the addon suite is still green" "0" "$?"
tail -3 "$RUN/regress-addon.log" | sed 's/^/   /'

note "VERDICT"
echo "   leaves: A=$A_LEAF (addon alone)  B=$B_LEAF (desktop alone)  C=$C_LEAF (both)"
if [ "$inconclusive" -gt 0 ]; then
  echo "   ⚑ $inconclusive INCONCLUSIVE — never scored as a pass"
fi
if [ "$fail" -eq 0 ]; then
  echo "════ WO-E7 GATE PASSED ════   $ok checks ok / 0 FAIL / $inconclusive inconclusive"
  exit 0
else
  echo "════ WO-E7 GATE FAILED ════   $ok ok / $fail FAIL / $inconclusive inconclusive"
  exit 1
fi
