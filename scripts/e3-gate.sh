#!/usr/bin/env bash
# WO-E3 gate. One command, non-zero if anything the work order asked for is
# not upheld.
#
#   stage 0  what is on the box, read from the two binaries themselves
#   stage 1  VACUITY CONTROL — the probe against a 4.2 profile with nothing
#            installed must answer "not enabled". A gate whose observable
#            cannot come back red proves nothing.
#   THE GATE the shipped zip installed through the MANIFEST path and read back
#            out of a SEPARATE running Blender: module, version, panels
#   stage 3  CONTROL — a manifest that cannot be parsed is REFUSED, and does
#            not silently fall back to bl_info
#   stage 4  CONTROL — a manifest that floors above this Blender is REFUSED,
#            with bl_info still declaring (3, 6, 0): the floor that is enforced
#            is the manifest's
#   stage 5  THE WORK ORDER'S OTHER CONTROL — the same zip against 3.0.1.
#            ⚑ IT DOES NOT HOLD. Measured, printed, and scored as a failure.
#
# Nothing here reads a pixel and nothing here reads a log line for its verdict:
# every assertion is a JSON field returned by bpy inside the running Blender,
# or a path on disk.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BL="$ROOT/vendor/blender/bin/blender"
SYSBL="${E3_SYSTEM_BLENDER:-/usr/bin/blender}"
ZIP="${E3_ZIP:-/data/scruple-blender/dist/scruple-blender-0.1.0.zip}"
WORK="$ROOT/.run/e3"
rc=0

stage(){ printf '\n════ %s ════\n' "$1"; }
# Pull the probe's JSON out of Blender's chatter. The markers are printed by
# the probe itself, so a Blender that died before running it yields nothing and
# the jq below fails loudly rather than reading a stale file.
probe_json(){ sed -n '/^<<<E3_PROBE$/,/^E3_PROBE>>>$/p' | sed '1d;$d'; }
field(){ python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d.get('$1')))" ; }

[ -x "$BL" ] || { echo "!! $BL missing — run scripts/e3-install-blender.sh"; exit 2; }
[ -f "$ZIP" ] || { echo "!! $ZIP missing — run build/build_addon.sh in the addon repo"; exit 2; }
mkdir -p "$WORK"

stage "stage 0 — what is on this box, asked of the binaries"
NEW_V="$("$BL" --version 2>/dev/null | sed -n 's/^Blender \([0-9.]*\).*/\1/p' | head -1)"
OLD_V="$("$SYSBL" --version 2>/dev/null | sed -n 's/^Blender \([0-9.]*\).*/\1/p' | head -1)"
MIN="$(sed -n 's/^blender_version_min = "\(.*\)"/\1/p' /data/scruple-blender/blender_manifest.toml 2>/dev/null)"
printf '   %-34s %s\n' "vendor/blender/bin/blender" "$NEW_V"
printf '   %-34s %s\n' "$SYSBL" "${OLD_V:-absent}"
printf '   %-34s %s\n' "blender_manifest.toml floors at" "${MIN:-?}"
printf '   %-34s %s\n' "the zip under test" "$(sha256sum "$ZIP" | cut -c1-16)…  $ZIP"
python3 - "$NEW_V" "${MIN:-4.2.0}" <<'PY' || rc=1
import sys
have = tuple(int(x) for x in sys.argv[1].split("."))
need = tuple(int(x) for x in sys.argv[2].split("."))
if have >= need:
    print(f"   PASS  the repo's Blender {sys.argv[1]} is at or above the manifest floor {sys.argv[2]}")
else:
    print(f"   FAIL  the repo's Blender {sys.argv[1]} is BELOW the manifest floor {sys.argv[2]}"); sys.exit(1)
PY
# The system Blender must still be the old one: stage 5 is only a control while
# it is, and this work order was not licensed to replace it.
if [ "$OLD_V" = "3.0.1" ]; then
  echo "   PASS  $SYSBL is untouched at 3.0.1 — stage 5 still has a subject"
else
  echo "   INCONCLUSIVE  $SYSBL reads '${OLD_V:-absent}', not 3.0.1; stage 5 is not the control it was written as"; rc=1
fi

stage "stage 1 — VACUITY CONTROL: the observable can come back red"
UR="$WORK/ur-empty"; rm -rf "$UR"; mkdir -p "$UR"
J="$(BLENDER_USER_RESOURCES="$UR" "$BL" --background --python "$ROOT/scripts/e3-probe.py" 2>/dev/null | probe_json)"
[ -n "$J" ] || { echo "   FAIL  the probe produced nothing"; rc=1; }
python3 - <<PY || rc=1
import json
d = json.loads(r'''$J''')
ok = d.get("matched_module") is None and not d["loaded_via_manifest"] and not d["panels_registered"]
print("   matched_module=%s  loaded_via_manifest=%s  panels=%d"
      % (d.get("matched_module"), d["loaded_via_manifest"], len(d["panels_registered"])))
print("   PASS  an empty profile reports NOT enabled — the gate below can fail" if ok
      else "   FAIL  an empty profile already reports the addon enabled; the gate is vacuous")
raise SystemExit(0 if ok else 1)
PY

stage "THE GATE — the shipped zip, installed through the MANIFEST path"
UR="$WORK/ur-42"; rm -rf "$UR"; mkdir -p "$UR"
echo "\$ blender --command extension install-file -r user_default -e <zip>"
BLENDER_USER_RESOURCES="$UR" "$BL" --command extension install-file -r user_default -e "$ZIP" 2>&1 | sed 's/^/   /'
# ⚑ The CLI exits 0 even when the install failed (stage 3 and 4 show it doing
# exactly that), so the exit code is not the observable. The filesystem and the
# next process are.
echo "   on disk: $(ls "$UR/extensions/user_default" 2>/dev/null | tr '\n' ' ')"

echo
echo "   the work order's literal form, --python-expr, in a SEPARATE process:"
BLENDER_USER_RESOURCES="$UR" "$BL" --background --python-expr \
  'import bpy;m=[a.module for a in bpy.context.preferences.addons if a.module.endswith("scruple_blender")];import addon_utils,sys;i=addon_utils.module_bl_info(sys.modules[m[0]]) if m else {};print("E3_EXPR module=%s version=%s min=%s panels=%d"%(m[0] if m else None,".".join(map(str,i.get("version",()))),".".join(map(str,i.get("blender",()))),len([n for n in dir(bpy.types) if n.startswith("SCRUPLE_PT_")])))' \
  2>/dev/null | grep '^E3_EXPR' | sed 's/^/   /'

J="$(BLENDER_USER_RESOURCES="$UR" "$BL" --background --python "$ROOT/scripts/e3-probe.py" 2>/dev/null | probe_json)"
python3 - <<PY || rc=1
import json
d = json.loads(r'''$J''')
ok = True
def check(label, got, want):
    global ok
    good = got == want
    ok = ok and good
    print("   %-46s %-42s %s" % (label, json.dumps(got), "ok" if good else "FAIL want %s" % json.dumps(want)))
check("the running Blender's version", d["blender_version_tuple"][:2], [4, 2])
check("the module, as Blender names it", d["matched_module"], "bl_ext.user_default.scruple_blender")
check("...which means the MANIFEST path", d["loaded_via_manifest"], True)
check("installed in the extensions repo", d.get("repo_module"), "user_default")
check("blender_manifest.toml is beside it", d.get("manifest_on_disk"), True)
check("NOT in scripts/addons (the bl_info path)", d["legacy_addons_dir_exists"], False)
# ⚑ THE DISCRIMINATOR, twice over. bl_info says (3,6,0) and a long description;
# blender_manifest.toml says 4.2.0 and the short tagline. What comes back names
# the file this Blender actually read.
check("the floor Blender read", d["reported"]["blender"], [4, 2, 0])
check("the description Blender read", d["reported"]["description"],
      "Provenance, C2PA, and chain-lock for Blender")
check("the addon version", d["reported"]["version"], [0, 1, 0])
check("panels registered", d["panels_registered"],
      ["SCRUPLE_PT_edits", "SCRUPLE_PT_locks", "SCRUPLE_PT_main",
       "SCRUPLE_PT_projects", "SCRUPLE_PT_receipt", "SCRUPLE_PT_tracker"])
print("   operators registered: %d" % len(d["operators_registered"]))
print("   PASS  the shipped zip enables through the manifest path, headless" if ok else "   NOT PASSED")
raise SystemExit(0 if ok else 1)
PY

# ── the two refusal controls. Derived from the SAME zip, one file changed. ──
mkdir -p "$WORK/zips"
mkzip(){ # <name> <sed-expression on blender_manifest.toml>
  local n="$1"; local e="$2"; local w="$WORK/zips/w-$n"
  rm -rf "$w"; mkdir -p "$w"; ( cd "$w" && unzip -qq "$ZIP" && sed -i "$e" scruple_blender/blender_manifest.toml \
      && rm -f "$WORK/zips/$n.zip" && zip -qr "$WORK/zips/$n.zip" scruple_blender )
}
refused(){ # <name> — install it into a fresh profile and report what survived
  local n="$1"; local ur="$WORK/ur-$n"
  rm -rf "$ur"; mkdir -p "$ur"
  BLENDER_USER_RESOURCES="$ur" "$BL" --command extension install-file -r user_default -e "$WORK/zips/$n.zip" 2>&1 \
    | grep -E '^(ERROR|STATUS|Package)' | sed 's/^/   blender: /'
  local inrepo inlegacy
  inrepo="$(ls "$ur/extensions/user_default" 2>/dev/null | grep -c scruple_blender)"
  inlegacy="$( [ -d "$ur/scripts/addons/scruple_blender" ] && echo 1 || echo 0)"
  local j; j="$(BLENDER_USER_RESOURCES="$ur" "$BL" --background --python "$ROOT/scripts/e3-probe.py" 2>/dev/null | probe_json)"
  local mod; mod="$(printf '%s' "$j" | field matched_module)"
  printf '   in the extensions repo: %s   in scripts/addons: %s   enabled module: %s\n' "$inrepo" "$inlegacy" "$mod"
  if [ "$inrepo" = 0 ] && [ "$inlegacy" = 0 ] && [ "$mod" = "null" ]; then
    echo "   PASS  refused, and NOT silently fallen back to bl_info"; return 0
  fi
  echo "   FAIL  something survived the refusal"; return 1
}

stage "stage 3 — CONTROL: a manifest Blender cannot parse is REFUSED"
mkzip corrupt-manifest '1i this is not = = valid toml [[['
refused corrupt-manifest || rc=1

stage "stage 3b — CONTROL: a manifest that PARSES but breaks its schema is REFUSED"
echo '   (valid TOML, the id key removed — a different reader from stage 3'"'"'s TOML parser)'
mkzip no-id '/^id = /d'
refused no-id || rc=1

stage "stage 4 — CONTROL: a manifest that floors above this Blender is REFUSED"
echo "   (bl_info in the same zip is untouched at (3, 6, 0); only the manifest moved)"
mkzip floor-above 's/^blender_version_min = .*/blender_version_min = "4.9.0"/'
refused floor-above || rc=1

stage "stage 5 — THE WORK ORDER'S OTHER CONTROL: the same zip against 3.0.1"
UR="$WORK/ur-301"; rm -rf "$UR"; mkdir -p "$UR/scripts" "$UR/config"
J="$(BLENDER_USER_SCRIPTS="$UR/scripts" BLENDER_USER_CONFIG="$UR/config" \
     "$SYSBL" --background --factory-startup --python "$ROOT/scripts/e3-legacy-attempt.py" -- "$ZIP" 2>/dev/null | probe_json)"
python3 - <<PY || rc=1
import json
d = json.loads(r'''$J''')
print("   Blender %s  ·  extensions system present: %s  ·  extension prefs: %s"
      % (d["blender_version"], d["has_extensions_op"], d["has_extensions_prefs"]))
print("   bl_info as 3.0.1 read it: blender=%s  description=%r"
      % (d.get("reported", {}).get("blender"), (d.get("reported", {}) or {}).get("description")))
print("   enable() raised: %s   is_enabled: %s   panels: %d"
      % (d["enable_raised"], d["is_enabled"], len(d["panels_registered"])))
held = True
# The half that DOES hold: there is no manifest reader on 3.0.1 at all, so the
# path this work order proves is unreachable there. That is what "the new
# install is what made the difference" amounts to.
if d["has_extensions_op"] or d["has_extensions_prefs"] or d["loaded_via_manifest"]:
    print("   FAIL  3.0.1 appears to have an extensions system"); held = False
else:
    print("   PASS  3.0.1 has NO manifest path — the zip can only arrive as a bl_info addon")
# The half the work order asked for, and it does not hold.
if d["is_enabled"]:
    print("   ⚑ CONTROL NOT UPHELD — 3.0.1 ENABLES the addon and registers all"
          " %d panels," % len(d["panels_registered"]))
    print("     although bl_info declares a minimum of %s. Blender's"
          % ".".join(map(str, d["reported"]["blender"])))
    print("     addon_utils.enable() does not read that field: on the legacy path the")
    print("     declared floor is ADVISORY, shown in the UI and enforced by nothing.")
    print("     The enforced floor is blender_manifest.toml's, and only on 4.2+ —")
    print("     which is what stage 4 measures. See docs/WO-E3.md.")
    held = False
else:
    print("   PASS  3.0.1 refuses to enable the addon")
raise SystemExit(0 if held else 1)
PY

stage "verdict"
if [ "$rc" = 0 ]; then echo "   WO-E3 PASSED"; else
  echo "   WO-E3 NOT PASSED — see the stages above and docs/WO-E3.md"; fi
exit $rc
