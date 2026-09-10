#!/usr/bin/env bash
# WO-F3 — THE STANDALONE ADD-ON DECLARES WHAT IT DID NOT OBSERVE.
#
#   npm run f3      (bash scripts/f3-gate.sh)
#
# Finding E7-1 / docs/STATE.md §4.7 — the finding the E series ends on. WO-E7
# built one Blender scene around an AI image the add-on never saw, then built
# the SAME scene around a DIFFERENT one, and the two leaves were identical in
# every field capable of describing how the artifact came to exist. Nothing on
# them was false. The claim was ABSENT, and absence and "there was nothing" read
# the same.
#
# The product decision is WO-F3's and is not reopened here: a declared field
# naming the imported datablocks and their digests. NOT `host_semantics: blind`
# (that asserts full byte coverage with no meaning, and this product has no byte
# coverage of the AI step at all) and NOT `declared_uncaptured` (whose scope is
# a closure over what an upstream reported, and there is no upstream here).
#
# THE GATE: two leaves built around two different imported AI images DIFFER in
# the new field, and each names the datablock and a digest that RE-HASHES FROM
# THE BYTES ON DISK — with sha256sum, from the shell, outside every process
# under test.
#
# THE CONTROLS:
#   (a) a scene with NO imported datablocks yields an EMPTY DECLARATION THAT IS
#       PRESENT — count 0, document stored — never an absent field. The two mean
#       different things, as they did in WO-E2.
#   (b) an imported datablock whose bytes cannot be read is recorded as
#       UNREADABLE, not omitted and not given somebody else's digest.
#   (c) the field is in the MAC: the five scalars are preimage fields, and the
#       declaration's digest is folded into `input_hash` — which the witness
#       hashes into the leaf it signs. Both halves are recomputed here from the
#       witness's OWN database, in Python, by a different implementation of the
#       same two formulas.
#   (d) a Desktop Studio leaf and an add-on leaf for the same artifact LINK by
#       digest — and one for a different artifact does not.
#
# AND THE RED-BEFORE, which is E7-1 reproduced live rather than quoted: STAGE 1
# checks the add-on's PARENT commit out into a worktree, builds its zip,
# installs it through the manifest path and runs the same two scenes. Its leaves
# declare nothing, and the two are identical in the new field and in
# `input_hash` — the measurement WO-E7 made, against today's server.
#
# 🔴 Rails. The only remote this gate dials is the scratch app on :3902 and,
# through it, the scratch witness on :5899. It opens the scratch witness's own
# sqlite READ-ONLY to recompute a leaf hash. Nothing touches :5799 or :3001,
# nothing touches /opt/scruple-witness, and $HOME is redirected per run so the
# SDK's key cache and spool stay out of the box's.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
ADDON="${SCRUPLE_ADDON_REPO:-/data/scruple-blender}"
WEB="${SCRUPLE_WEB_REPO:-/data/scruple-web}"
RUN="$REPO/.run/f3"; mkdir -p "$RUN"
APP="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
DB="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
WDB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
BLENDER="$REPO/vendor/blender/bin/blender"
PROFILE="$RUN/profile"
AI_A="$RUN/images/ai-a.png"
AI_B="$RUN/images/ai-b.png"
# ⚑ ONE SCENE NAME, ONE WORK DIRECTORY, ONE IMPORTED FILENAME for every run
# that is COMPARED against another. WO-E7's experiment is "the same scene around
# a different image", and the first run of this gate got it wrong three ways at
# once: the scene name carried the run's label, the .blend sat in the run's own
# directory, and the imported file kept its own name. All three ride in the save
# workflow or the machine manifest — `build_save_workflow` puts the scene name
# and the absolute path in, and `machine_manifest_hash` folds the UNREDACTED
# workflow — so `workflow_hash` and `machine_manifest_hash` moved for reasons
# that had nothing to do with the AI image, and the invariance the finding is
# about could not be measured. The image is COPIED to one name before each run;
# what differs between two runs is the bytes and nothing else.
SCENE="f3-scene"
SCENEDIR="$RUN/scene"

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-64s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-64s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
differs(){ if [ "$2" != "$3" ]; then printf '   ok    %-64s %s != %s\n' "$1" "${2:0:12}" "${3:0:12}"; ok=$((ok+1));
           else printf '   FAIL  %-64s both %s\n' "$1" "${2:0:12}"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-64s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }
q(){ sqlite3 "file:$DB?mode=ro" -batch "$1" 2>/dev/null; }
J(){ python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
cur=d
for k in sys.argv[2].split('.'):
    if cur is None: break
    cur=cur[int(k)] if isinstance(cur,list) else cur.get(k)
# json.dumps for anything that is not a string, so a boolean reads as JSON
# rather than as Python's spelling of it — the first run of this gate scored two
# FAILs on exactly that, comparing a JSON document's value against a shell
# string. And no backticks in this comment: it is inside a double-quoted shell
# string, so the shell would run them.
print('-' if cur is None else (cur if isinstance(cur,str) else json.dumps(cur)))
" "$1" "$2" 2>/dev/null || echo '-'; }

[ -f "$DB" ] || { echo "!! no scratch database at $DB"; exit 2; }
[ -x "$BLENDER" ] || { echo "!! no Blender at $BLENDER — run scripts/e3-install-blender.sh"; exit 2; }
[ -d "$ADDON/.git" ] || { echo "!! no add-on repo at $ADDON"; exit 2; }
node "$REPO/vendor/scruple-web/scripts/preflight-schema.mjs" --apply >"$RUN/preflight.log" 2>&1 \
  || { echo "!! schema preflight failed — see $RUN/preflight.log"; exit 2; }

note "STAGE 0 — what is under test, named rather than described"
echo "   add-on repo   $ADDON @ $(git -C "$ADDON" rev-parse --short HEAD)"
echo "   server repo   $WEB @ $(git -C "$WEB" rev-parse --short HEAD)"
echo "   app           $APP"
echo "   database      $DB"
echo "   witness db    $WDB  (read-only)"
echo "   schema        $(tail -1 "$RUN/preflight.log")"
WATERMARK="$(q "SELECT COALESCE(MAX(id),0) FROM iterations;")"
echo "   watermark     leaf id > $WATERMARK is this run's"

AFTER_REF="$(git -C "$ADDON" log --format=%H -1 --grep='^WO-F3:' 2>/dev/null)"
if [ -z "$AFTER_REF" ]; then
  incon "the add-on's WO-F3 commit is resolvable" "no commit whose subject starts WO-F3:"
  BEFORE_REF=""
else
  BEFORE_REF="$(git -C "$ADDON" rev-parse "$AFTER_REF^")"
  echo "   after         $(git -C "$ADDON" rev-parse --short "$AFTER_REF")  $(git -C "$ADDON" log --format=%s -1 "$AFTER_REF")"
  echo "   before        $(git -C "$ADDON" rev-parse --short "$BEFORE_REF")  $(git -C "$ADDON" log --format=%s -1 "$BEFORE_REF")"
fi

KEY="${F3_ADDON_KEY:-}"
if [ -z "$KEY" ]; then
  if [ -f "$REPO/.run/e7/addon-key.json" ]; then
    KEY="$(python3 -c "import json;print(json.load(open('$REPO/.run/e7/addon-key.json'))['apiKey'])")"
  else
    KEY="$(bash scripts/tsx.sh scripts/e7-addon-key.ts --print-key 2>>"$RUN/key.log")"
  fi
fi
[ -n "$KEY" ] || { echo "!! no add-on API key — run scripts/e7-addon-key.ts"; exit 2; }
echo "   add-on key    ${KEY:0:12}…  (the add-on's own tenant, not the desktop's)"

# ⚑ THE TWO AI IMAGES, and where they come from matters. These are the outputs
# of two ComfyUI generations Desktop Studio witnessed in WO-E7's run, days ago,
# in a different product, with no identifier shared with anything below. That is
# what makes control (d) a composition rather than a coincidence.
mkdir -p "$RUN/images"
cp "$REPO/.run/e7/a1/imported.png" "$AI_A"
cp "$REPO/.run/e7/a2/imported.png" "$AI_B"
A_SHA="$(sha256sum "$AI_A" | cut -d' ' -f1)"
B_SHA="$(sha256sum "$AI_B" | cut -d' ' -f1)"
echo "   AI image A    $A_SHA"
echo "   AI image B    $B_SHA"
differs "the two AI images are different bytes" "$A_SHA" "$B_SHA"
A_STUDIO="$(q "SELECT id FROM iterations WHERE output_hash='$A_SHA' AND component_verified=1 ORDER BY id LIMIT 1;")"
B_STUDIO="$(q "SELECT id FROM iterations WHERE output_hash='$B_SHA' AND component_verified=1 ORDER BY id LIMIT 1;")"
echo "   A's Desktop Studio leaf: ${A_STUDIO:-<none>}    B's: ${B_STUDIO:-<none>}"

build_zip(){ # build_zip <tree> <label> -> path
  ( cd "$1" && bash build/build_addon.sh ) >>"$RUN/build-$2.log" 2>&1
  ls "$1"/dist/scruple-blender-*.zip 2>/dev/null | head -1
}
install_manifest(){ # install_manifest <zip>
  rm -rf "$PROFILE"; mkdir -p "$PROFILE" "$RUN/install-home"
  BLENDER_USER_RESOURCES="$PROFILE" HOME="$RUN/install-home" timeout 900 "$BLENDER" \
    --command extension install-file -r user_default -e "$1" >>"$RUN/install.log" 2>&1
  [ -d "$PROFILE/extensions/user_default/scruple_blender" ] && echo yes || echo no
}
# f3run <label> [extra args...] — one Blender, the add-on's own save_post
# handler doing the capturing, HOME moved and SCRUPLE_COMFY_HOST_DIR unset so
# no gate can be in the run.
f3run(){
  local label="$1" w="$2"; shift 2
  mkdir -p "$w" "$RUN/home-$label"
  env -u SCRUPLE_COMFY_HOST_DIR HOME="$RUN/home-$label" BLENDER_USER_RESOURCES="$PROFILE" \
    timeout 1800 "$BLENDER" --background --python "$REPO/scripts/f3-addon-alone.py" -- \
      --api-key "$KEY" --base-url "$APP" --work "$w" --scene "$SCENE" "$@" \
      >"$RUN/$label.log" 2>&1
  python3 - "$RUN/$label.log" "$RUN/$label.json" <<'PY'
import json,re,sys
t=open(sys.argv[1], errors="replace").read()
m=re.search(r'<<<F3_ADDON\n(.*?)\nF3_ADDON>>>', t, re.S)
if not m:
    sys.stderr.write(t[-2000:]); raise SystemExit("no report from Blender")
json.dump(json.loads(m.group(1)), open(sys.argv[2],'w'), indent=1)
PY
}
leaf_of(){ J "$RUN/$1.json" receipts.0.leaf_id; }
col(){ q "SELECT COALESCE(CAST($2 AS TEXT),'(NULL)') FROM iterations WHERE id=$1;"; }
# The digest the LEAF carries for a named datablock, read out of the stored
# document rather than out of anything Blender said.
docdigest(){ q "SELECT imported_datablocks FROM iterations WHERE id=$1;" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d['datablocks']:
    if m['datablock']==sys.argv[1]: print(m['digest'] or '(null)'); break
else: print('(no such datablock)')
" "$2"; }

note "STAGE 1 — ⚑ THE RED BEFORE: the add-on at its PARENT commit, E7-1 live"
if [ -n "$BEFORE_REF" ]; then
  WT="$RUN/before-tree"
  rm -rf "$WT"
  git -C "$ADDON" worktree add --detach "$WT" "$BEFORE_REF" >>"$RUN/worktree.log" 2>&1
  BEFORE_ZIP="$(build_zip "$WT" before)"
  if [ -z "$BEFORE_ZIP" ]; then
    incon "the parent commit's zip could be built" "see $RUN/build-before.log"
  else
    echo "   before zip   $(sha256sum "$BEFORE_ZIP" | cut -c1-16)…"
    check "the before zip installs through the manifest path" "yes" "$(install_manifest "$BEFORE_ZIP")"
    rm -rf "$SCENEDIR"; mkdir -p "$SCENEDIR"
    cp "$AI_A" "$SCENEDIR/imported.png"; f3run b1 "$SCENEDIR" --images "$SCENEDIR/imported.png"
    B1_BLEND="$(sha256sum "$SCENEDIR/f3-addon-alone.blend" | cut -d' ' -f1)"
    cp "$AI_B" "$SCENEDIR/imported.png"; f3run b2 "$SCENEDIR" --images "$SCENEDIR/imported.png"
    B2_BLEND="$(sha256sum "$SCENEDIR/f3-addon-alone.blend" | cut -d' ' -f1)"
    B1="$(leaf_of b1)"; B2="$(leaf_of b2)"
    echo "   before leaves  b1=$B1 (image A)   b2=$B2 (image B)"
    if [ -z "$B1" ] || [ -z "$B2" ]; then
      incon "the parent commit's add-on produced two leaves" "b1=$B1 b2=$B2"
    else
      check "⚑ the OLD add-on's leaf declares NO imported datablocks at all" "(NULL)" "$(col "$B1" imported_datablocks_source)"
      check "…and no count, so 'looked and found none' cannot be read either" "(NULL)" "$(col "$B1" imported_datablocks_count)"
      check "…and no origin answer: nothing says whether anyone watched" "(NULL)" "$(col "$B1" imported_origin_observed)"
      check "…and no document" "(NULL)" "$(col "$B1" imported_datablocks)"
      # ⚑ THE MEASUREMENT WO-E7 MADE. Two different AI images inside the same
      # scene, and every field that could say so is identical.
      for c in imported_datablocks_source imported_datablocks_count imported_datablocks_hash \
               imported_origin_observed input_hash workflow_hash machine_manifest_hash \
               model_fingerprints_hash host_semantics; do
        check "⚑ RED: $c is IDENTICAL for two different AI images" "$(col "$B1" "$c")" "$(col "$B2" "$c")"
      done
      differs "…and only the .blend's own bytes moved, which is E7-1 exactly" \
        "$B1_BLEND" "$B2_BLEND"
      check "…those bytes being the two leaves' own output_hash" "$B1_BLEND/$B2_BLEND" \
        "$(col "$B1" output_hash)/$(col "$B2" output_hash)"
    fi
  fi
  git -C "$ADDON" worktree remove --force "$WT" >>"$RUN/worktree.log" 2>&1
else
  incon "the red-before stage ran" "no parent commit resolved"
fi

note "STAGE 2 — ⚑ THE GATE: the shipped add-on, two scenes, two different imports"
AFTER_ZIP="$(build_zip "$ADDON" after)"
[ -n "$AFTER_ZIP" ] || { echo "!! could not build the add-on zip — see $RUN/build-after.log"; exit 2; }
echo "   after zip    $(sha256sum "$AFTER_ZIP" | cut -c1-16)…"
check "the shipped zip installs through the manifest path" "yes" "$(install_manifest "$AFTER_ZIP")"
# The tamper surface of the INSTALLED tree, computed with the SDK's own
# function. Reported, not asserted: F1-1 measured that this number moves with
# the install DIRECTORY, so a fixed expectation would be a fixture of the path.
TSH="$(PYTHONPATH="$ADDON/vendor" python3 -c "
from scruple_api import manifest as m
import os
root='$PROFILE/extensions/user_default/scruple_blender'
print(m.compute_tamper_surface_hash(integration_version=open(os.path.join(root,'VERSION')).read().strip(),
      config={'host':'blender'},
      code_paths=[os.path.join(root,'__init__.py'),os.path.join(root,'adapter'),
                  os.path.join(root,'operators'),os.path.join(root,'panels'),
                  os.path.join(root,'vendor')]))" 2>/dev/null)"
echo "   installed tamper surface  ${TSH:-<not computed>}"

rm -rf "$SCENEDIR"; mkdir -p "$SCENEDIR"
cp "$AI_A" "$SCENEDIR/imported.png"; f3run a1 "$SCENEDIR" --images "$SCENEDIR/imported.png"
A1_BLEND="$(sha256sum "$SCENEDIR/f3-addon-alone.blend" | cut -d' ' -f1)"
cp "$AI_B" "$SCENEDIR/imported.png"; f3run a2 "$SCENEDIR" --images "$SCENEDIR/imported.png"
A2_BLEND="$(sha256sum "$SCENEDIR/f3-addon-alone.blend" | cut -d' ' -f1)"
A1="$(leaf_of a1)"; A2="$(leaf_of a2)"
echo "   after leaves   a1=$A1 (image A)   a2=$A2 (image B)"
check "the add-on loaded through the manifest path" "true" "$(J "$RUN/a1.json" loaded_via_manifest)"
check "⚑ no gate was in this run (SCRUPLE_COMFY_HOST_DIR unset)" "-" "$(J "$RUN/a1.json" host_dir_env)"
check "it was configured through the preferences fields (WO-F1's fix)" "true" "$(J "$RUN/a1.json" preferences_bound)"
check "…and it talked to the sandbox, not production" "$APP" "$(J "$RUN/a1.json" base_url)"
if [ -z "$A1" ] || [ -z "$A2" ]; then
  incon "the shipped add-on produced two leaves" "a1=$A1 a2=$A2"
else
  check "the leaf's output_hash is the sha256sum of the .blend on disk" "$A1_BLEND" "$(col "$A1" output_hash)"
  differs "the two .blends differ, because the packed image differs" "$A1_BLEND" "$A2_BLEND"
  check "⚑ THE GATE: the two leaves DIFFER in the new field" "different" \
    "$([ "$(col "$A1" imported_datablocks_hash)" != "$(col "$A2" imported_datablocks_hash)" ] && echo different || echo IDENTICAL)"
  check "…and each declares the host's own datablock table as the source" "host_datablocks" "$(col "$A1" imported_datablocks_source)"
  check "…one datablock, counted" "1" "$(col "$A1" imported_datablocks_count)"
  check "…none unreadable" "0" "$(col "$A1" imported_datablocks_unreadable_count)"
  check "⚑ …and it says NOBODY HERE WATCHED IT ARRIVE, as a value" "0" "$(col "$A1" imported_origin_observed)"
  # ⚑ THE DIGEST RE-HASHES FROM THE BYTES ON DISK, with sha256sum, outside
  # every process under test. This is the check the whole field rests on: a
  # digest nobody else can reproduce would be a decoration.
  check "⚑ A's declared digest IS sha256sum of the imported image" "$A_SHA" "$(docdigest "$A1" imported-0)"
  check "⚑ B's declared digest IS sha256sum of the OTHER image" "$B_SHA" "$(docdigest "$A2" imported-0)"
  # ⚑ AND THE DECLARATION DIFFERS ONLY IN THE DIGEST. Same datablock name, same
  # basename, same count, same scope: the two documents are byte-identical apart
  # from 64 hex characters, which is what makes this a measurement of the bytes
  # rather than of the harness.
  check "…the two documents differ only in the digest and the byte count" "bytes,digest" \
    "$(python3 -c "
import json,sqlite3,sys
con=sqlite3.connect('file:$DB?mode=ro',uri=True)
g=lambda i: json.loads(con.execute('SELECT imported_datablocks FROM iterations WHERE id=?',(i,)).fetchone()[0])
a,b=g($A1),g($A2)
top=[k for k in a if k!='datablocks' and a[k]!=b.get(k)]
m1,m2=a['datablocks'][0],b['datablocks'][0]
inner=[k for k in m1 if m1[k]!=m2.get(k)]
print(','.join(sorted(top+inner)) or 'nothing')")"
  check "…and the stored document re-hashes to the stored digest" "$(col "$A1" imported_datablocks_hash)" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A1;" | tr -d '\n' | sha256sum | cut -d' ' -f1)"
  check "the datablock is named, not just counted" "imported-0" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A1;" | python3 -c "import json,sys;print(json.load(sys.stdin)['datablocks'][0]['datablock'])")"
  check "the scope it enumerated over travels with it" '["image"]' \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A1;" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['datablock_types']))")"
  check "the filename is a BASENAME, not a user's directory layout" "imported.png" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A1;" | python3 -c "import json,sys;print(json.load(sys.stdin)['datablocks'][0]['filename'])")"
  check "…and it says WHICH bytes were hashed" "packed_bytes" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A1;" | python3 -c "import json,sys;print(json.load(sys.stdin)['datablocks'][0]['digest_of'])")"
  # ⚑ AND WHAT THIS DOES NOT CLOSE, asserted so it stays visible.
  check "⚑ host_semantics is STILL NULL — F3 does not make this leaf a gate" "(NULL)" "$(col "$A1" host_semantics)"
  check "⚑ model_fingerprints_hash is still NULL — nobody here saw weights" "(NULL)" "$(col "$A1" model_fingerprints_hash)"
  check "⚑ and workflow_hash is STILL invariant under the AI step (E7-1's other half)" \
    "$(col "$A1" workflow_hash)" "$(col "$A2" workflow_hash)"
fi

note "STAGE 3 — CONTROL (a): a scene with no imports declares an EMPTY SET THAT IS PRESENT"
f3run a3 "$RUN/a3" --no-imports
A3="$(leaf_of a3)"
echo "   leaf a3=$A3   image datablocks in the file: $(J "$RUN/a3.json" image_datablocks)"
if [ -z "$A3" ]; then
  incon "the empty-scene run produced a leaf" "-"
else
  check "the source is declared, so somebody looked" "host_datablocks" "$(col "$A3" imported_datablocks_source)"
  check "⚑ the count is 0 — a cardinality, not an absence" "0" "$(col "$A3" imported_datablocks_count)"
  check "…the document is PRESENT and its list is empty" "[]" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A3;" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['datablocks']))")"
  check "…the origin question is answered rather than skipped" "0" "$(col "$A3" imported_origin_observed)"
  differs "⚑ and it is DISTINGUISHABLE from the old add-on's silence" \
    "$(col "$A3" imported_datablocks_count)" "$(col "${B1:-0}" imported_datablocks_count)"
  # ⚑ ANTI-VACUITY. `Render Result` and `Viewer Node` are in bpy.data.images on
  # every real Blender startup, so a filter that counted datablocks rather than
  # reading `Image.source` would declare two imports here — and this control
  # would pass for the wrong reason.
  check "⚑ ANTI-VACUITY: the file DOES hold image datablocks all the same" "2" \
    "$(python3 -c "import json;print(len(json.load(open('$RUN/a3.json'))['image_datablocks']))")"
  check "…and neither the render result nor the viewer is called an import" "0" "$(col "$A3" imported_datablocks_count)"
fi

note "STAGE 4 — CONTROL (b): a datablock whose bytes cannot be read"
cp "$AI_B" "$RUN/images/will-be-deleted.png"
f3run a4 "$RUN/a4" --images "$AI_A" --unpacked "$RUN/images/will-be-deleted.png" --delete-unpacked
A4="$(leaf_of a4)"
echo "   leaf a4=$A4"
if [ -z "$A4" ]; then
  incon "the unreadable-datablock run produced a leaf" "-"
else
  check "both datablocks are declared" "2" "$(col "$A4" imported_datablocks_count)"
  check "⚑ one of them is counted as unreadable" "1" "$(col "$A4" imported_datablocks_unreadable_count)"
  check "⚑ …and it is a MEMBER with a reason, not an omission" "source_file_missing" \
    "$(q "SELECT imported_datablocks FROM iterations WHERE id=$A4;" | python3 -c "
import json,sys
[m]=[m for m in json.load(sys.stdin)['datablocks'] if m['digest'] is None]
print(m['unreadable'])")"
  check "…it carries no digest rather than somebody else's" "(null)" "$(docdigest "$A4" linked-by-path)"
  check "…and the READABLE one still has its own" "$A_SHA" "$(docdigest "$A4" imported-0)"
fi

note "STAGE 5 — CONTROL (c): the field is in the MAC, and it moves the leaf hash"
# c-1: the five scalars are preimage fields, and the digest moves the preimage.
#      Read out of the server's own function, from the shell.
PRE="$(cd "$WEB" && node --import tsx -e "
import {componentPreimage} from './lib/leaf/componentPreimage.ts';
const mk=(h)=>componentPreimage({content_hash:'c'.repeat(64),component:{component_id:'x',counter:0},
  imported_datablocks_source:'host_datablocks',imported_origin_observed:false,
  imported_datablocks_count:1,imported_datablocks_unreadable_count:0,imported_datablocks_hash:h});
const a=mk('a'.repeat(64)), b=mk('b'.repeat(64));
const keys=Object.keys(a).filter(k=>k.startsWith('imported_'));
console.log(JSON.stringify({keys, moves:a.imported_datablocks_hash!==b.imported_datablocks_hash,
  doc_in_preimage:Object.hasOwn(a,'imported_datablocks')}));" 2>>"$RUN/preimage.log")"
echo "   preimage keys $PRE"
check "⚑ all five scalars are in the MAC preimage" "5" \
  "$(python3 -c "import json;print(len(json.loads('''$PRE''')['keys']))" 2>/dev/null || echo '-')"
check "…and a changed digest changes the preimage" "true" \
  "$(python3 -c "import json;print(str(json.loads('''$PRE''')['moves']).lower())" 2>/dev/null || echo '-')"
check "…while the DOCUMENT is not in it (a member list cannot ride in a MAC)" "false" \
  "$(python3 -c "import json;print(str(json.loads('''$PRE''')['doc_in_preimage']).lower())" 2>/dev/null || echo '-')"

# c-2: ⚑ AND THE HALF THAT MATTERS FOR THIS PRODUCT. The add-on sends NO
#      component and NO mac — `component_verified` is 0 on every leaf it
#      writes — so the ratchet binds nothing here. What binds the declaration
#      is the leaf: the digest is folded into `input_hash`, and the witness
#      hashes `input_hash` into the record whose sha256 IS the leaf hash it
#      signs. Both recomputed below, in Python, from the witness's own file.
if [ -n "${A1:-}" ]; then
  check "the add-on's leaf carries no component, as this product never does" "0" "$(col "$A1" component_verified)"
  A1_DECL="$(col "$A1" imported_datablocks_hash)"
  FOLD="$(python3 "$REPO/scripts/f3-leaf-arithmetic.py" input-hash "$A1_DECL" | python3 -c "import json,sys;print(json.load(sys.stdin)['input_hash'])")"
  check "⚑ input_hash on the leaf IS the fold of the declaration's digest" "$(col "$A1" input_hash)" "$FOLD"
  A1_LEAF_HASH="$(col "$A1" leaf_hash)"
  LH="$RUN/leaf-hash-a1.json"
  python3 "$REPO/scripts/f3-leaf-arithmetic.py" leaf-hash "$WDB" "$A1_LEAF_HASH" > "$LH" 2>>"$RUN/arith.log"
  check "the witness's own row for this leaf is a v2.2 record" "v2.2" "$(J "$LH" leaf_scheme)"
  check "⚑ …and recomputing it from that row reproduces the leaf hash it signed" "true" "$(J "$LH" matches)"
  # One hex digit of the declaration's digest, flipped, and carried all the way
  # through: declaration -> input_hash -> the witness's record -> the leaf hash.
  TAMPERED_DECL="$(python3 -c "
d='$A1_DECL'; print(('0' if d[0]!='0' else '1')+d[1:])")"
  TAMPERED_FOLD="$(python3 "$REPO/scripts/f3-leaf-arithmetic.py" input-hash "$TAMPERED_DECL" | python3 -c "import json,sys;print(json.load(sys.stdin)['input_hash'])")"
  differs "one flipped digit in the declaration moves input_hash" "$FOLD" "$TAMPERED_FOLD"
  LH2="$RUN/leaf-hash-a1-tampered.json"
  python3 "$REPO/scripts/f3-leaf-arithmetic.py" leaf-hash-with "$WDB" "$A1_LEAF_HASH" "$TAMPERED_FOLD" > "$LH2" 2>>"$RUN/arith.log"
  check "⚑ …and THEREFORE moves the leaf hash the witness signed" "true" "$(J "$LH2" moved)"
  echo "   signed leaf   $A1_LEAF_HASH"
  echo "   with one digit of one datablock's digest changed: $(J "$LH2" recomputed_with_substituted_input_hash)"
  # ⚑ RED FOR THIS CONTROL, and it is stage 1's leaves: the old add-on sent no
  # declaration, so there was nothing folded and input_hash was NULL on BOTH
  # runs — the same leaf-level silence, whichever image was inside.
  if [ -n "${B1:-}" ]; then
    check "⚑ RED: the OLD add-on's leaf folded nothing into input_hash" "(NULL)" "$(col "$B1" input_hash)"
  fi
fi

# c-3: the live refusals — the two halves cannot be separated on the wire.
post(){ curl -s -o "$RUN/refusal.json" -w '%{http_code}' -m 20 -X POST "$APP/api/v2/witness" \
          -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data "$1"; }
BASE_REF="$(J "$RUN/a1.json" baseline_ref)"
DOC='{"source":"host_datablocks","origin_observed":false,"datablock_types":["image"],"datablocks":[]}'
GOODHASH="$(PYTHONPATH="$ADDON/vendor" python3 -c "
import json
from scruple_host_sdk import imported_datablocks as i
print(i.document_hash(json.loads('$DOC')))")"
mk(){ python3 -c "
import json,sys,hashlib,os
body={'baseline_ref':'$BASE_REF','kind':'document_save','mime':'application/x-blender',
 'content_hash':hashlib.sha256(os.urandom(16)).hexdigest(),
 'imported_datablocks':json.loads('''$DOC'''),
 'imported_datablocks_source':'host_datablocks','imported_origin_observed':False,
 'imported_datablocks_count':0,'imported_datablocks_unreadable_count':0,
 'imported_datablocks_hash':'$GOODHASH'}
over=json.loads(sys.argv[1]) if len(sys.argv)>1 else {}
for k,v in over.items():
    if v is None: body.pop(k,None)
    else: body[k]=v
print(json.dumps(body))" "$1"; }
check "an honest empty declaration is accepted" "201" "$(post "$(mk '{}')")"
check "…a digest that does not match its document is refused" "422" \
  "$(post "$(mk '{"imported_datablocks_hash":"abababababababababababababababababababababababababababababababab"}')")"
check "…and the code says which field" "imported_datablocks_refused" "$(J "$RUN/refusal.json" error.code)"
check "a digest with NO document is refused" "422" "$(post "$(mk '{"imported_datablocks":null}')")"
check "a document with NO digest is refused" "422" "$(post "$(mk '{"imported_datablocks_hash":null}')")"
check "an enumerated source with no count is refused" "422" "$(post "$(mk '{"imported_datablocks_count":null}')")"
check "…and that one names the REQUIRED code, not the refused one" "imported_datablocks_required" "$(J "$RUN/refusal.json" error.code)"
check "⚑ a leaf claiming it WATCHED the import is refused" "422" "$(post "$(mk '{"imported_origin_observed":true}')")"
check "…with the blocker named rather than a downgrade" "imported_datablocks_refused" "$(J "$RUN/refusal.json" error.code)"
check "a precomputed input_hash beside a declaration is refused" "422" \
  "$(post "$(mk '{"input_hash":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"}')")"
check "a caller forging the reserved input kind is refused" "422" \
  "$(post "$(mk '{"inputs":[{"kind":"imported_datablocks","hash":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"}]}')")"
# ⚑ CONTROL FOR THE CONTROLS: declaring NOTHING must still be accepted, or this
# field would be a new requirement on every existing caller.
check "⚑ and a submission that declares NOTHING is still accepted" "201" \
  "$(post "$(mk '{"imported_datablocks":null,"imported_datablocks_source":null,"imported_origin_observed":null,"imported_datablocks_count":null,"imported_datablocks_unreadable_count":null,"imported_datablocks_hash":null}')")"
check "…and that leaf reads NULL, not an empty declaration" "(NULL)" \
  "$(col "$(J "$RUN/refusal.json" leaf_id)" imported_datablocks_source)"

note "STAGE 6 — CONTROL (d): the two products link by digest"
if [ -z "${A1:-}" ] || [ -z "$B_STUDIO" ] || [ -z "$A_STUDIO" ]; then
  incon "both a Desktop Studio leaf and an add-on leaf exist for these images" "studio A=$A_STUDIO B=$B_STUDIO a1=$A1"
else
  # THE JOIN. Given a witnessed artifact's content hash, which documents
  # imported it — over the stored declaration, with NO identifier shared
  # between the two leaves except the digest of the bytes.
  JOINED="$(q "SELECT p.id FROM iterations p JOIN iterations s ON s.output_hash='$A_SHA'
               WHERE p.id=$A1 AND p.imported_datablocks LIKE '%'||'$A_SHA'||'%' LIMIT 1;")"
  check "⚑ the add-on's leaf JOINS to the Desktop Studio leaf for the same bytes" "$A1" "${JOINED:-<no join>}"
  echo "   Desktop Studio leaf $A_STUDIO witnessed $A_SHA on $(q "SELECT timestamp FROM iterations WHERE id=$A_STUDIO;")"
  echo "   the add-on's leaf   $A1 declared the same digest on $(q "SELECT timestamp FROM iterations WHERE id=$A1;")"
  check "…and the studio side is a real component leaf, not another plugin one" "1" "$(col "$A_STUDIO" component_verified)"
  # CONTROL: the other image's leaf must NOT join to A's artifact.
  WRONG="$(q "SELECT p.id FROM iterations p WHERE p.id=$A2 AND p.imported_datablocks LIKE '%'||'$A_SHA'||'%' LIMIT 1;")"
  check "CONTROL: the leaf built around the OTHER image does not join" "<no join>" "${WRONG:-<no join>}"
  check "⚑ and neither leaf overclaims: the add-on still says it watched nothing" "0" "$(col "$A1" imported_origin_observed)"
fi

note "STAGE 7 — the suites that must not go red"
( cd "$ADDON" && timeout 1800 python3 -m pytest -q tests > "$RUN/suite-addon.log" 2>&1 )
check "the add-on suite is green" "0" "$?"
tail -1 "$RUN/suite-addon.log" | sed 's/^/   /'
( cd "$WEB" && timeout 2400 npm run test:v2 > "$RUN/suite-v2.log" 2>&1 )
check "the server's v2 suite is green" "0" "$?"
grep -E '^# (tests|pass|fail)' "$RUN/suite-v2.log" | sed 's/^/   /'
( cd "$WEB" && timeout 1800 npm run test:sdk > "$RUN/suite-sdk.log" 2>&1 )
check "the SDK suite is green" "0" "$?"
tail -1 "$RUN/suite-sdk.log" | sed 's/^/   /'

note "VERDICT"
echo "   before  b1=${B1:-–} b2=${B2:-–}   (the add-on's parent commit: declares nothing)"
echo "   after   a1=${A1:-–} a2=${A2:-–}   a3=${A3:-–} (no imports)  a4=${A4:-–} (one unreadable)"
[ -n "${A1:-}" ] && q "SELECT id, imported_datablocks_source, imported_datablocks_count,
   imported_datablocks_unreadable_count, imported_origin_observed,
   substr(imported_datablocks_hash,1,12), substr(input_hash,1,12)
   FROM iterations WHERE id IN (${B1:-0},${B2:-0},${A1:-0},${A2:-0},${A3:-0},${A4:-0}) ORDER BY id;" | sed 's/^/   /'
if [ "$inconclusive" -gt 0 ]; then echo "   ⚑ $inconclusive INCONCLUSIVE — never scored as a pass"; fi
if [ "$fail" -eq 0 ]; then
  echo "════ WO-F3 GATE PASSED ════   $ok checks ok / 0 FAIL / $inconclusive inconclusive"
  exit 0
else
  echo "════ WO-F3 GATE FAILED ════   $ok ok / $fail FAIL / $inconclusive inconclusive"
  exit 1
fi
