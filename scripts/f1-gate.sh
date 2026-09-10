#!/usr/bin/env bash
# WO-F1 — THE ADD-ON'S SETTINGS UI MUST BIND ON THE PATH IT SHIPS ON.
#
#   npm run f1      (bash scripts/f1-gate.sh)
#
# Finding E7-2 / docs/STATE.md §4.8. `ScrupleAddonPreferences.bl_idname` was the
# literal "scruple_blender" — the module name on the LEGACY scripts/addons path.
# Through blender_manifest.toml, which is what WO-E3 made work and what every
# 4.2+ user gets, Blender enables the add-on as
# `bl_ext.user_default.scruple_blender`, the two strings do not match, and
# `addons[module].preferences` is None. No API key field, no base URL field —
# and `get_base_url()` therefore falling through to the SDK default, which is
# https://scruple.ai. Production.
#
# THE GATE: the shipped zip installed through the MANIFEST path exposes both
# preference fields, and get_base_url() returns the configured sandbox URL.
#
# THE CONTROLS:
#   (a) with nothing configured, `scruple.ai` is NOT what an unconfigured call
#       yields — the production fallback is gone, shown red before and green
#       after with the same probe;
#   (b) the LEGACY path still binds — the fix did not trade one path for the
#       other;
#   (c) the add-on suite is green, with the moved baselines enumerated.
#
# ⚑ HOW "RED BEFORE" IS DONE HERE. Not by describing the old behaviour: by
# BUILDING THE OLD ZIP. The parent of the add-on repo's WO-F1 commit is checked
# out into a worktree, packaged with build/build_addon.sh, and installed and
# probed through the same two paths as the new one. Both trees are installed at
# THE SAME absolute profile path, one after the other, because
# compute_tamper_surface_hash() keys its file map by absolute path — two
# profiles would have produced two different hashes for reasons that have
# nothing to do with the change.
#
# 🔴 Rails. Stages 0-6 contact nothing: Blender runs --background against local
# zips and the "sandbox URL" is a string typed into a preferences field and read
# back, never dialled. STAGE 6 DOES make network calls — it lands a real leaf —
# and they go to the scratch app on :3902 and the scratch witness on :5899 and
# nowhere else. Nothing here touches :5799 or :3001. $HOME is redirected so the
# SDK's auth cache under ~/.scruple is this gate's and not the box's.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
ADDON="${SCRUPLE_ADDON_REPO:-/data/scruple-blender}"
RUN="$REPO/.run/f1"; mkdir -p "$RUN"
BLENDER="$REPO/vendor/blender/bin/blender"
SANDBOX="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"

# ONE profile path, reused. See the note above about absolute paths.
PROFILE="$RUN/profile-manifest"
LEGACY="$RUN/profile-legacy"
HOMEDIR="$RUN/home"

# Declared up front: `set -u` is on and stage 6 reads measurements that stage 5
# only takes when its own stage packaged successfully.
BEFORE_ZIP=""; AFTER_ZIP=""; BEFORE_SHA=""; AFTER_SHA=""
BEFORE_SURFACE=""; AFTER_SURFACE=""; BEFORE_ROOT=""; AFTER_ROOT=""
BEFORE_ATTACH=""; AFTER_ATTACH=""

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-66s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-66s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
differs(){ if [ "$2" != "$3" ]; then printf '   ok    %-66s %s ≠ %s\n' "$1" "${2:0:16}" "${3:0:16}"; ok=$((ok+1));
         else printf '   FAIL  %-66s both %s\n' "$1" "${2:0:24}"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-66s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }
J(){ python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
cur=d
for k in sys.argv[2].split('.'):
    if cur is None: break
    if isinstance(cur,list): cur=cur[int(k)] if len(cur)>int(k) else None
    else: cur=cur.get(k)
print('-' if cur is None else cur)
" "$1" "$2" 2>/dev/null || echo '-'; }

DB="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
q(){ sqlite3 "file:$DB?mode=ro" -batch "$1" 2>/dev/null; }

# The add-on's baseline as WO-E7 recorded it. Superseded by this work order;
# it is here so the gate can prove it moved instead of claiming it.
E7_BASELINE="22e97c93c1d8176d950358c49a5726bfee0c824f795c158f6560de0c49138a91"

[ -x "$BLENDER" ] || { echo "!! no Blender at $BLENDER — run scripts/e3-install-blender.sh"; exit 2; }
[ -d "$ADDON/.git" ] || { echo "!! no add-on repo at $ADDON"; exit 2; }

note "STAGE 0 — what is under test, named rather than described"
echo "   blender        $("$BLENDER" --version 2>/dev/null | head -1)"
echo "   add-on repo    $ADDON @ $(git -C "$ADDON" rev-parse --short HEAD)"
echo "   sandbox string $SANDBOX  (typed into a field; never dialled)"
echo "   profile path   $PROFILE  (the same for both trees, on purpose)"

# The change, resolved from the repo rather than from a hardcoded sha.
AFTER_REF="$(git -C "$ADDON" log --format=%H -1 --grep='^WO-F1:' 2>/dev/null)"
if [ -z "$AFTER_REF" ]; then
  incon "the add-on's WO-F1 commit is resolvable" "no commit whose subject starts WO-F1:"
  BEFORE_REF=""
else
  BEFORE_REF="$(git -C "$ADDON" rev-parse "$AFTER_REF^")"
  echo "   after          $(git -C "$ADDON" rev-parse --short "$AFTER_REF")  $(git -C "$ADDON" log --format=%s -1 "$AFTER_REF")"
  echo "   before         $(git -C "$ADDON" rev-parse --short "$BEFORE_REF")  $(git -C "$ADDON" log --format=%s -1 "$BEFORE_REF")"
fi

# ── packaging and probing, one function each ────────────────────────────────
build_zip(){ # build_zip <tree> <label>  -> echoes the zip path
  local tree="$1" label="$2"
  # SCRUPLE_WEB_ROOT is pointed at nothing so build/vendor_sdk.sh VERIFIES the
  # committed vendor/ instead of refreshing it from the server repo. Both trees
  # are then packaged with the vendor/ they were committed with, which is what
  # makes the two tamper surface hashes comparable at all.
  ( cd "$tree" && SCRUPLE_WEB_ROOT=/nonexistent bash build/build_addon.sh ) \
    > "$RUN/build-$label.log" 2>&1
  ls "$tree"/dist/scruple-blender-*.zip 2>/dev/null | head -1
}

install_manifest(){ # install_manifest <zip>
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  BLENDER_USER_RESOURCES="$PROFILE" HOME="$HOMEDIR" timeout 900 "$BLENDER" \
    --command extension install-file -r user_default -e "$1" >> "$RUN/install.log" 2>&1
  [ -d "$PROFILE/extensions/user_default/scruple_blender" ] && echo yes || echo no
}

install_legacy(){ # install_legacy <zip>
  rm -rf "$LEGACY"; mkdir -p "$LEGACY/scripts/addons"
  unzip -q "$1" -d "$LEGACY/scripts/addons"
  [ -d "$LEGACY/scripts/addons/scruple_blender" ] && echo yes || echo no
}

probe(){ # probe <profile> <out.json> [enable-module]
  rm -rf "$HOMEDIR"; mkdir -p "$HOMEDIR"
  BLENDER_USER_RESOURCES="$1" HOME="$HOMEDIR" timeout 900 "$BLENDER" --background \
    --python "$REPO/scripts/f1-prefs-probe.py" -- --sandbox "$SANDBOX" ${3:+--enable "$3"} \
    > "$RUN/$(basename "$2" .json).log" 2>&1
  sed -n '/<<<F1_PREFS/,/F1_PREFS>>>/p' "$RUN/$(basename "$2" .json).log" | sed '1d;$d' > "$2"
  [ -s "$2" ] || echo '{}' > "$2"
}

# ════════════════════════════════════════════════════════════════════════════
if [ -n "$BEFORE_REF" ]; then
note "STAGE 1 — ⚑ THE CONTROL, RED BEFORE. The old zip, built from $(git -C "$ADDON" rev-parse --short "$BEFORE_REF")."
WT="$RUN/before-tree"
git -C "$ADDON" worktree remove --force "$WT" 2>/dev/null || true
rm -rf "$WT"
git -C "$ADDON" worktree add -q --detach "$WT" "$BEFORE_REF" 2>>"$RUN/worktree.log"
if [ ! -f "$WT/adapter/preferences.py" ]; then
  incon "the before-tree could be checked out" "see $RUN/worktree.log"
else
  grep -q "addon_module_name" "$WT/adapter/preferences.py" && HASFN=yes || HASFN=no
  check "the before-tree does not know how to resolve the module name" "no" "$HASFN"
  BEFORE_ZIP="$(build_zip "$WT" before)"
  if [ -z "$BEFORE_ZIP" ]; then
    incon "the before-tree packaged" "see $RUN/build-before.log"
  else
    BEFORE_SHA="$(sha256sum "$BEFORE_ZIP" | cut -c1-64)"
    echo "   before zip   $BEFORE_SHA"
    check "the before zip installs through the manifest path" "yes" "$(install_manifest "$BEFORE_ZIP")"
    probe "$PROFILE" "$RUN/before-manifest.json"
    echo "   module        $(J "$RUN/before-manifest.json" enabled.0.module)"
    check "⚑ RED: the MANIFEST path does NOT bind the Settings UI" "False" \
      "$(J "$RUN/before-manifest.json" enabled.0.preferences_bound)"
    check "⚑ RED: …so there is nowhere to paste an API key" "False" \
      "$(J "$RUN/before-manifest.json" enabled.0.api_key_settable)"
    check "⚑ RED: …and nowhere to set a base URL" "False" \
      "$(J "$RUN/before-manifest.json" enabled.0.base_url_settable)"
    check "⚑ RED (control a): an unconfigured base URL IS production" "https://scruple.ai" \
      "$(J "$RUN/before-manifest.json" base_url_unconfigured)"
    check "⚑ RED: a key with no base URL still built a client, at production" "https://scruple.ai" \
      "$(J "$RUN/before-manifest.json" client_with_key_and_no_base_url)"
    BEFORE_SURFACE="$(J "$RUN/before-manifest.json" tamper_surface_hash)"
    BEFORE_ROOT="$(J "$RUN/before-manifest.json" addon_root)"
    echo "   surface hash  $BEFORE_SURFACE"

    check "the before zip unpacks on the legacy path" "yes" "$(install_legacy "$BEFORE_ZIP")"
    probe "$LEGACY" "$RUN/before-legacy.json" scruple_blender
    check "…and the LEGACY path binds, so the class itself was never broken" "True" \
      "$(J "$RUN/before-legacy.json" enabled.0.preferences_bound)"
  fi
fi
fi

# ════════════════════════════════════════════════════════════════════════════
note "STAGE 2 — ⚑ THE GATE. The shipped zip, built from the add-on repo's HEAD."
AFTER_ZIP="$(build_zip "$ADDON" after)"
if [ -z "$AFTER_ZIP" ]; then
  incon "the add-on packaged" "see $RUN/build-after.log"
else
AFTER_SHA="$(sha256sum "$AFTER_ZIP" | cut -c1-64)"
echo "   after zip    $AFTER_SHA"
check "the shipped zip installs through the manifest path" "yes" "$(install_manifest "$AFTER_ZIP")"
probe "$PROFILE" "$RUN/after-manifest.json"
echo "   module        $(J "$RUN/after-manifest.json" enabled.0.module)"
echo "   bl_idname     $(J "$RUN/after-manifest.json" bl_idname)"
check "⚑ the MANIFEST path binds the Settings UI" "True" \
  "$(J "$RUN/after-manifest.json" enabled.0.preferences_bound)"
check "…and it is the add-on's own class" "ScrupleAddonPreferences" \
  "$(J "$RUN/after-manifest.json" enabled.0.preferences_type)"
check "⚑ the API key field is there" "True" \
  "$(J "$RUN/after-manifest.json" enabled.0.api_key_settable)"
check "⚑ the base URL field is there" "True" \
  "$(J "$RUN/after-manifest.json" enabled.0.base_url_settable)"
check "…and the verbose-logging toggle" "True" \
  "$(J "$RUN/after-manifest.json" enabled.0.verbose_logging_settable)"
check "bl_idname is the module Blender enabled, not the legacy literal" \
  "$(J "$RUN/after-manifest.json" enabled.0.module)" "$(J "$RUN/after-manifest.json" bl_idname)"
check "…resolved, not hardcoded" \
  "$(J "$RUN/after-manifest.json" enabled.0.module)" "$(J "$RUN/after-manifest.json" addon_module_name)"
check "⚑ THE GATE: a URL set in the field is what get_base_url() returns" "$SANDBOX" \
  "$(J "$RUN/after-manifest.json" roundtrip.get_base_url)"
check "…and a key pasted into the field is what get_api_key() returns" "sk_f1_probe_roundtrip" \
  "$(J "$RUN/after-manifest.json" roundtrip.get_api_key)"

note "STAGE 3 — CONTROL (a): the production fallback is gone"
echo "   unconfigured get_base_url() -> '$(J "$RUN/after-manifest.json" base_url_unconfigured)'"
check "⚑ scruple.ai is NOT what an unconfigured call yields" "False" \
  "$(J "$RUN/after-manifest.json" unconfigured_is_production)"
# `J` prints a bare `-` for JSON null and the value itself otherwise, so an
# empty string prints as nothing. Name it, or the check reads as a bug.
UNCONF="$(J "$RUN/after-manifest.json" base_url_unconfigured)"
check "…it yields nothing at all, which is what nobody-said means" "<empty>" \
  "$([ -z "$UNCONF" ] && echo '<empty>' || echo "$UNCONF")"
check "…and a key with no base URL builds NO client rather than one at production" "-" \
  "$(J "$RUN/after-manifest.json" client_with_key_and_no_base_url)"

note "STAGE 4 — CONTROL (b): the legacy path still binds"
check "the shipped zip unpacks on the legacy path" "yes" "$(install_legacy "$AFTER_ZIP")"
probe "$LEGACY" "$RUN/after-legacy.json" scruple_blender
echo "   module        $(J "$RUN/after-legacy.json" enabled.0.module)"
echo "   bl_idname     $(J "$RUN/after-legacy.json" bl_idname)"
check "the LEGACY path still binds the Settings UI" "True" \
  "$(J "$RUN/after-legacy.json" enabled.0.preferences_bound)"
check "…under the legacy module name, so nothing was traded away" "scruple_blender" \
  "$(J "$RUN/after-legacy.json" bl_idname)"
check "…and its field round-trips too" "$SANDBOX" \
  "$(J "$RUN/after-legacy.json" roundtrip.get_base_url)"
check "…and IT does not fall back to production either" "False" \
  "$(J "$RUN/after-legacy.json" unconfigured_is_production)"

note "STAGE 5 — the baselines this moves, measured rather than asserted"
AFTER_SURFACE="$(J "$RUN/after-manifest.json" tamper_surface_hash)"
AFTER_ATTACH="$(J "$RUN/after-manifest.json" attach_surface_hash)"
BEFORE_ATTACH="$(J "$RUN/before-manifest.json" attach_surface_hash 2>/dev/null)"
AFTER_ROOT="$(J "$RUN/after-manifest.json" addon_root)"
echo "   before surface  ${BEFORE_SURFACE:-<not measured>}"
echo "   after  surface  $AFTER_SURFACE"
echo "   before zip      ${BEFORE_SHA:-<not measured>}"
echo "   after  zip      $AFTER_SHA"
if [ -n "${BEFORE_SURFACE:-}" ] && [ "${BEFORE_SURFACE}" != "-" ]; then
  check "both trees were measured at the SAME install path (so the hash moved for content)" \
    "$BEFORE_ROOT" "$AFTER_ROOT"
  differs "⚑ the tamper surface hash MOVED — this is a different integration" \
    "$BEFORE_SURFACE" "$AFTER_SURFACE"
  echo "   before attach-hash  $BEFORE_ATTACH"
  echo "   after  attach-hash  $AFTER_ATTACH"
  differs "…and so did the one a baseline is actually keyed by (config folded in)" \
    "$BEFORE_ATTACH" "$AFTER_ATTACH"
  # ⚑ NOT a `differs` on the zip digests. `build/build_addon.sh` writes
  # mtimes into the archive, so two builds of the SAME tree do not agree —
  # measured: stage 1 produced a different zip digest on two consecutive runs
  # of this gate. A check that passes whether or not the code changed is not
  # evidence. The reproducible content measure is the file inside it.
  BEFORE_PREFS="$(unzip -p "$BEFORE_ZIP" scruple_blender/adapter/preferences.py | sha256sum | cut -c1-64)"
  AFTER_PREFS="$(unzip -p "$AFTER_ZIP" scruple_blender/adapter/preferences.py | sha256sum | cut -c1-64)"
  differs "…and adapter/preferences.py inside the zip is different bytes" "$BEFORE_PREFS" "$AFTER_PREFS"
  echo "   (the zip digests differ too, but they differ between builds of one tree — mtimes)"
else
  incon "the tamper surface hash moved" "no before-tree measurement to compare against"
fi
fi

note "STAGE 6 — ⚑ THE RE-RECORD: a real leaf, configured through the field this fix restored"
# The work order asks for the moved baselines to be re-recorded deliberately.
# This is that: the add-on, on the manifest path, pointed at the scratch app by
# SETTING ITS PREFERENCES FIELDS and nothing else, saving a .blend, and letting
# its own save_post handler witness it. WO-E7 had to write the SDK's auth cache
# instead, because there was no field — so a leaf coming back here is a side
# effect of the fix rather than a restatement of it.
if [ ! -f "$RUN/../e7/addon-key.json" ] && [ -z "${F1_ADDON_KEY:-}" ]; then
  incon "the add-on has a key of its own" "run scripts/e7-addon-key.ts first"
else
  KEY="${F1_ADDON_KEY:-$(bash scripts/tsx.sh scripts/e7-addon-key.ts --print-key 2>>"$RUN/key.log")}"
  if [ -z "$KEY" ]; then
    incon "the add-on's API key could be read" "see $RUN/key.log"
  else
    WATERMARK="$(q 'SELECT COALESCE(MAX(id),0) FROM iterations;')"
    OLD_LEAVES="$(q "SELECT COUNT(*) FROM iterations WHERE baseline_hash='$E7_BASELINE';")"
    echo "   iterations watermark $WATERMARK; leaves on the OLD add-on baseline: $OLD_LEAVES"
    # The manifest profile still holds the after-zip from stage 2.
    rm -rf "$HOMEDIR" "$RUN/work"; mkdir -p "$HOMEDIR" "$RUN/work"
    BLENDER_USER_RESOURCES="$PROFILE" HOME="$HOMEDIR" timeout 1200 "$BLENDER" --background \
      --python "$REPO/scripts/f1-addon-baseline.py" -- \
      --api-key "$KEY" --base-url "$SANDBOX" --work "$RUN/work" > "$RUN/baseline.log" 2>&1
    sed -n '/<<<F1_BASELINE/,/F1_BASELINE>>>/p' "$RUN/baseline.log" | sed '1d;$d' > "$RUN/baseline.json"
    [ -s "$RUN/baseline.json" ] || echo '{}' > "$RUN/baseline.json"

    check "the preferences object is there to configure" "True" \
      "$(J "$RUN/baseline.json" preferences_bound)"
    check "⚑ nothing was written to the SDK auth cache — the FIELD is the only source" "False" \
      "$(J "$RUN/baseline.json" auth_cache_present)"
    check "a session client was built from it" "$SANDBOX" \
      "$(J "$RUN/baseline.json" client_base_url)"
    LEAF="$(J "$RUN/baseline.json" captures.0.leaf_id)"
    echo "   capture state $(J "$RUN/baseline.json" captures.0.state)  leaf $LEAF"
    check "the add-on's own save_post handler landed a witnessed leaf" "witnessed" \
      "$(J "$RUN/baseline.json" captures.0.state)"
    if [ -z "$LEAF" ] || [ "$LEAF" = "-" ]; then
      incon "the new leaf's baseline_hash could be read" "no leaf id in the capture record"
    else
      NEW_BASELINE="$(q "SELECT baseline_hash FROM iterations WHERE id='$LEAF';")"
      CLIENT_TSH="$(J "$RUN/baseline.json" tamper_surface_hash)"
      check "…and this leaf is new, not a re-read of an old one" "yes" \
        "$([ "$LEAF" -gt "$WATERMARK" ] 2>/dev/null && echo yes || echo no)"
      echo "   code running now   $CLIENT_TSH"
      echo "   leaf 's baseline   ${NEW_BASELINE:-<not found>}"
      echo "   E7 recorded        $E7_BASELINE"
      check "the running build's hash is the one this gate measured at this path" \
        "$AFTER_ATTACH" "$CLIENT_TSH"
      differs "⚑ …and it is NOT the baseline the leaf went out under" \
        "$CLIENT_TSH" "$NEW_BASELINE"

      # ⚑⚑ FINDING F1-2, ASSERTED SO IT GOES RED WHEN SOMEBODY FIXES IT.
      #
      # `Client.attach()` GETs /api/v2/baseline/current, and when the tenant
      # already HAS an active baseline it adopts the server's ref whatever the
      # local hash is — `drifted=True`, and then it witnesses anyway. So the
      # add-on's code changed, the SDK noticed, and leaf $LEAF still carries
      # the baseline of the OLD bytes. `iterations.baseline_hash` on an add-on
      # leaf answers "what did this tenant first attach with", not "what code
      # produced this". `rebaseline()` exists in the SDK and nothing calls it.
      #
      # This is not WO-F1's to fix — it is the SDK's attach path and it affects
      # every host — so it is recorded, with its control, and named in
      # docs/WO-F1.md. The two checks below are a defect being pinned:
      check "⚑ F1-2: the leaf carries the STALE baseline WO-E7 recorded" \
        "$E7_BASELINE" "$NEW_BASELINE"
      check "…and the drift IS detected and reported, which is the honest half" "yes" \
        "$(J "$RUN/baseline.json" last_error | grep -qi 'baseline drift' && echo yes || echo no)"
      check "…so the count on the old baseline GREW by this leaf, rather than stopping" \
        "$((OLD_LEAVES + 1))" "$(q "SELECT COUNT(*) FROM iterations WHERE baseline_hash='$E7_BASELINE';")"
    fi
  fi
fi

note "STAGE 7 — CONTROL (c): the add-on's own suite"
( cd "$ADDON" && timeout 1800 python3 -m pytest -q ) > "$RUN/pytest.log" 2>&1
PYT=$?
tail -1 "$RUN/pytest.log" | sed 's/^/   /'
check "the add-on suite is green" "0" "$PYT"

note "RESULT"
printf '   ok %d   fail %d   inconclusive %d\n' "$ok" "$fail" "$inconclusive"
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then
  echo "   WO-F1 GATE: PASS"
elif [ "$fail" -eq 0 ]; then
  echo "   WO-F1 GATE: INCONCLUSIVE — an inconclusive control is never a pass"
  exit 1
else
  echo "   WO-F1 GATE: FAIL"
  exit 1
fi
