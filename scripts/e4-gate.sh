#!/usr/bin/env bash
# WO-E4 gate. One command, non-zero if anything the work order asked for is
# not upheld.
#
#   stage 0  the sandbox — a key and a baseline over app/comfy's own source
#   stage 1  THE CONTROL, RED BEFORE THE CHANGE AND GREEN AFTER. The addon zip
#            built from the commit BEFORE this work order, installed into a
#            Blender of its own and asked the same two questions.
#   stage 2  STATIC controls: the gate never changes, and the addon registers
#            through the SDK's own register_host rather than a lookalike
#   stage 3  the addon's own suite
#   stage 4  ⚑ WHAT THE ADDON REFUSES TO SAY — a real Blender, a scene with no
#            camera, and nothing written
#   THE GATE one generation announced by the addon, and a leaf that reads
#            `supplied` with the scene facts in the MAC
#   stage 6  the four leaves, read FROM THE SHELL out of the app database:
#            supplied ≠ blind ≠ declined, and a wrong prompt id says LESS
#   stage 7  the audit sweeps — every mutation reddens exactly what it targets
#   stage 8  WO-D6 still passes: the phantom host and the blind gate
#   control  a passing run must NOT satisfy --expect-fail
#
# Nothing here reads a pixel and nothing here reads a log line for its verdict.
# Every Blender assertion is a JSON field returned by bpy inside the running
# Blender or a path on disk; every leaf assertion is a column in sqlite.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
export SCRUPLE_APP_URL="$APP_URL"
export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
# ── schema preflight ────────────────────────────────────────────────────────
# WO-E4 finding E4-0: when the database is behind the tree, a gate fails as
# ASSERTION ERRORS and says nothing about the cause — WO-D6 was silently red for
# over an hour that way, reporting `no iteration row` eleven times. Exit 3 below
# means MIGRATIONS PENDING and is not a test failure. On a fresh clone every
# migration is pending, so this is the difference between a first run that
# explains itself and one that looks like a platform bug.
node vendor/scruple-web/scripts/preflight-schema.mjs --apply || {
  echo "GATE ABORTED: schema preflight failed — this is NOT a test failure."; exit 3; }
export SCRUPLE_WITNESS_DB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
export SCRUPLE_BDK_ALLOW_DEV="${SCRUPLE_BDK_ALLOW_DEV:-1}"
ADDON="${SCRUPLE_BLENDER_ROOT:-/data/scruple-blender}"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
BL="$ROOT/vendor/blender/bin/blender"
ZIP="${E4_ZIP:-$ADDON/dist/scruple-blender-0.1.0.zip}"
WORK="$ROOT/.run/e4"
BEFORE_TREE="${E4_BEFORE_TREE:-/tmp/e4-before}"
# One installed profile for the whole gate. It is this repo's Blender and this
# repo's zip; reusing it saves ~40s per scenario on an emulated CPU (E3-2).
export E4_BLENDER_PROFILE="${E4_BLENDER_PROFILE:-$WORK/profile}"
rc=0

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }
newest(){ ls -dt .run/d2/$1-* 2>/dev/null | head -1; }
blender_json(){ sed -n '/^<<<E4_BLENDER$/,/^E4_BLENDER>>>$/p' | sed '1d;$d'; }

[ -x "$BL" ] || { echo "!! $BL missing — run scripts/e3-install-blender.sh"; exit 2; }
[ -f "$ZIP" ] || { echo "!! $ZIP missing — run build/build_addon.sh in $ADDON"; exit 2; }
mkdir -p "$WORK"

stage "stage 0 — the sandbox, baselined over app/comfy/"
bash scripts/tsx.sh scripts/d3-sandbox.ts --surface app/comfy || { echo "   sandbox failed"; exit 2; }

# Install the addon once, into the profile every later stage reuses.
if [ ! -d "$E4_BLENDER_PROFILE/extensions/user_default/scruple_blender" ]; then
  echo "   (installing $(basename "$ZIP") into $E4_BLENDER_PROFILE)"
  rm -rf "$E4_BLENDER_PROFILE"; mkdir -p "$E4_BLENDER_PROFILE"
  BLENDER_USER_RESOURCES="$E4_BLENDER_PROFILE" "$BL" --command extension install-file \
    -r user_default -e "$ZIP" 2>&1 | sed 's/^/   blender: /'
fi
# ⚑ E3-3: that CLI exits 0 on a refused install. The directory is the observable.
if [ -d "$E4_BLENDER_PROFILE/extensions/user_default/scruple_blender" ]; then
  echo "   PASS  the addon is installed through the manifest path in $E4_BLENDER_PROFILE"
else
  echo "   FAIL  the addon did not land in the extensions repo"; rc=1
fi

stage "stage 1 — THE CONTROL, RED BEFORE THE CHANGE"
# The addon zip built from the commit BEFORE adapter/host_hook.py existed,
# installed into a Blender profile of its own, asked the same two questions the
# tree after the change is asked. Resolved FROM THE CHANGE, never from HEAD:
# the parent of the commit that first ADDED the file cannot move, so this
# comparison keeps meaning the same thing however many work orders land after.
E4_COMMIT=$(git -C "$ADDON" log --diff-filter=A --format=%H -- adapter/host_hook.py | tail -1)
BASE="${E4_COMMIT:+$E4_COMMIT^}"; BASE="${BASE:-HEAD}"
echo "   (the before-tree is $ADDON @ $BASE)"
if [ ! -f "$WORK/before.zip" ]; then
  rm -rf "$BEFORE_TREE"
  git -C "$ADDON" worktree add -f "$BEFORE_TREE" "$BASE" >/dev/null 2>&1 \
    || { echo "   FAIL  could not materialise the before-tree"; rc=1; }
  ( cd "$BEFORE_TREE" && bash build/build_addon.sh >/dev/null 2>&1 ) \
    && cp "$BEFORE_TREE/dist/scruple-blender-0.1.0.zip" "$WORK/before.zip" \
    || { echo "   FAIL  could not build the before-tree's zip"; rc=1; }
  git -C "$ADDON" worktree remove --force "$BEFORE_TREE" >/dev/null 2>&1
fi
probe_zip(){ # <zip> <profile> — install it, run the same script, print JSON
  local zip="$1" prof="$2" hd="$3"
  rm -rf "$prof" "$hd"; mkdir -p "$prof" "$hd"
  BLENDER_USER_RESOURCES="$prof" "$BL" --command extension install-file \
    -r user_default -e "$zip" >/dev/null 2>&1
  SCRUPLE_COMFY_HOST_DIR="$hd" BLENDER_USER_RESOURCES="$prof" \
    "$BL" --background --python "$ROOT/scripts/e4-blender-host.py" -- \
      --host-dir "$hd" --prompt-id ctl-1 --scene ctl-scene --frame 3 --camera CAM_ctl \
      2>/dev/null | blender_json
}
BEFORE_J="$(probe_zip "$WORK/before.zip" "$WORK/profile-before" "$WORK/hostdir-before")"
AFTER_J="$(probe_zip "$ZIP" "$WORK/profile-after" "$WORK/hostdir-after")"
python3 - "$BEFORE_J" "$AFTER_J" <<'PY' || rc=1
import json, sys
def load(s):
    try: return json.loads(s)
    except Exception: return {}
b, a = load(sys.argv[1]), load(sys.argv[2])
def row(label, kb, ka):
    print(f"   {label:<50}{json.dumps(kb):<26}{json.dumps(ka)}")
print(f"   {'':<50}{'BEFORE':<26}AFTER")
row("enabling the addon writes a declaration", b.get("declaration_exists"), a.get("declaration_exists"))
row("bpy.ops.scruple.host_announce exists",
    "host_announce" in (b.get("operators") or []), "host_announce" in (a.get("operators") or []))
row("the generation is announced", b.get("announce_exists"), a.get("announce_exists"))
ok = True
if not b: print("   FAIL  the before-tree produced no report at all"); ok = False
if b.get("declaration_exists") or "host_announce" in (b.get("operators") or []) or b.get("announce_exists"):
    print("   FAIL  the pre-change addon already declares or announces — the control is vacuous"); ok = False
if not (a.get("declaration_exists") and "host_announce" in (a.get("operators") or []) and a.get("announce_exists")):
    print("   FAIL  the post-change addon does not declare and announce"); ok = False
if b.get("blender_version") != a.get("blender_version"):
    print("   FAIL  the two probes did not run on the same Blender"); ok = False
print("   PASS  both were RED before this change and are GREEN after, on the same Blender "
      f"{a.get('blender_version')}" if ok else "   NOT PASSED")
sys.exit(0 if ok else 1)
PY

stage "stage 2 — STATIC controls"
# ⚑ THE GATE NEVER CHANGES. docs/BLENDER.md: "if a WO here needs a change to
# the gate, that is a finding to report, not a licence". Measured, not asserted.
if [ -z "$(git -C "$WEB" status --porcelain)" ]; then
  echo "   PASS  the server repo is untouched by this work order"
else
  echo "   FAIL  the server repo has uncommitted changes:"; git -C "$WEB" status --porcelain | sed 's/^/       /'; rc=1
fi
E4_DESKTOP_BASE="${E4_DESKTOP_BASE:-$(git log --format=%H -1 --grep='^WO-E3:')}"
if [ -n "$E4_DESKTOP_BASE" ]; then
  CHANGED="$(git diff --name-only "$E4_DESKTOP_BASE" -- app/ | tr '\n' ' ')"
  if [ -z "$CHANGED" ]; then
    echo "   PASS  app/ is unchanged since $E4_DESKTOP_BASE — the hook took no new seam"
  else
    echo "   FAIL  app/ changed: $CHANGED"; rc=1
  fi
else
  echo "   INCONCLUSIVE  no WO-E3 commit to diff app/ against"; rc=1
fi
# The addon registers through the SDK's OWN mirror of registerHost.
if grep -q "from scruple_api.host_registry import" "$ADDON/adapter/host_hook.py" \
   && grep -q "register_host(registration())" "$ADDON/adapter/host_hook.py"; then
  echo "   PASS  the addon validates its declaration through scruple_api.host_registry"
else
  echo "   FAIL  the addon does not register through the SDK's register_host"; rc=1
fi
# ...and does not reimplement any of it. A local copy of the refusal codes, of
# the canonicalization, or of the evidence hash would be a second implementation
# that could drift from the one the gate runs.
hits=$(grep -nE "canonicalize|sha256|host_evidence_hash|_HOST_ID *=|host_may_not_grade" \
        "$ADDON/adapter/host_hook.py" | grep -vE "^[0-9]+: *#" || true)
if [ -n "$hits" ]; then
  echo "   FAIL — the addon reimplements part of the registry:"; echo "$hits" | sed 's/^/       /'; rc=1
else
  echo "   PASS  no local canonicalization, hashing or refusal codes in the addon's adapter"
fi
if [ -f "$ADDON/vendor/scruple_api/host_registry.py" ]; then
  echo "   PASS  the mirror is vendored in the zip, so the check travels with the addon"
else
  echo "   FAIL  scruple_api/host_registry.py is not vendored"; rc=1
fi

stage "stage 3 — the addon's own suite"
( cd "$ADDON" && python3 -m pytest -q 2>&1 | tail -3 ) || rc=1

stage "stage 4 — ⚑ WHAT THE ADDON REFUSES TO SAY"
# A real Blender, a scene with no camera, and the addon's own schema check.
# `hostAdapterSink`'s check is presence-only, so `{"camera": null}` would be
# accepted and a leaf would read `supplied` with a null camera inside the MAC
# (finding E4-2). The addon refuses to produce the document at all.
HD="$WORK/hostdir-nocam"; PF="$WORK/profile-nocam"
rm -rf "$HD"; mkdir -p "$HD"
[ -d "$PF/extensions/user_default/scruple_blender" ] || {
  rm -rf "$PF"; mkdir -p "$PF"
  BLENDER_USER_RESOURCES="$PF" "$BL" --command extension install-file -r user_default -e "$ZIP" >/dev/null 2>&1
}
NOCAM_J="$(SCRUPLE_COMFY_HOST_DIR="$HD" BLENDER_USER_RESOURCES="$PF" \
  "$BL" --background --python "$ROOT/scripts/e4-blender-host.py" -- \
  --host-dir "$HD" --prompt-id nocam-1 --scene nocam-scene --frame 1 --no-camera 2>/dev/null | blender_json)"
python3 - "$NOCAM_J" "$HD" <<'PY' || rc=1
import json, os, sys
d = json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
ok = True
print("   the scene Blender held:  camera=%s  engine=%s"
      % (json.dumps((d.get("scene_as_blender_holds_it") or {}).get("camera")),
         json.dumps((d.get("scene_as_blender_holds_it") or {}).get("engine"))))
print("   bpy.ops.scruple.host_announce returned %s" % d.get("announce_status"))
if d.get("announce_status") != ["CANCELLED"]:
    print("   FAIL  the operator did not cancel"); ok = False
if d.get("announce_exists"):
    print("   FAIL  a document was written for a scene with no camera"); ok = False
files = os.listdir(os.path.join(sys.argv[2], "announce")) if os.path.isdir(os.path.join(sys.argv[2], "announce")) else []
print("   announce/ contains: %s" % (files or "nothing"))
if files:
    print("   FAIL  the announcement directory is not empty"); ok = False
# The declaration IS still there: the integration is set up, it just had
# nothing sayable about this scene. That is `declined`, not `blind`.
if not d.get("declaration_exists"):
    print("   FAIL  the declaration is missing too — this would read `blind`, not `declined`"); ok = False
print("   PASS  nothing was announced, and the declaration is still there:"
      " the leaf will read `declined`, which is true" if ok else "   NOT PASSED")
sys.exit(0 if ok else 1)
PY

stage "THE GATE — one generation announced by the addon"
echo "\$ node scripts/desktop-run.mjs blender-host"
node scripts/desktop-run.mjs blender-host --url "$APP_URL" || rc=1
SUP="$(newest clean)"

stage "stage 6 — supplied ≠ blind ≠ declined, and a wrong id says LESS"
node scripts/desktop-run.mjs blender-host --url "$APP_URL" --break no-host-adapter --expect-fail >/dev/null 2>&1
BLIND="$(newest break-no-host-adapter)"
node scripts/desktop-run.mjs blender-host --url "$APP_URL" --break no-announcement --expect-fail >/dev/null 2>&1
DEC="$(newest break-no-announcement)"
node scripts/desktop-run.mjs blender-host --url "$APP_URL" --break announce-under-a-different-id --expect-fail >/dev/null 2>&1
WRONG="$(newest break-announce-under-a-different-id)"
read_hash(){ python3 -c "
import json
try: print(json.load(open('$1/result.json'))['steps']['gen']['value']['images'][0]['sha256'])
except Exception: print('')
"; }
read_scene(){ python3 -c "
import json
try: print(json.load(open('$1/spec.json'))['fixtures']['blender']['scene'])
except Exception: print('')
"; }
printf '   %-30s %-10s %-9s %-18s %s\n' RUN SEMANTICS HOST ADAPTER "EVIDENCE?"
seen=""
for pair in "supplied:$SUP" "blind:$BLIND" "declined:$DEC" "declined:$WRONG"; do
  want="${pair%%:*}"; dir="${pair#*:}"
  H="$(read_hash "$dir")"
  if [ -z "$H" ]; then echo "   FAIL  no artifact hash in ${dir:-<no run>}"; rc=1; continue; fi
  ROW=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
    "SELECT COALESCE(host_semantics,'(null)') || '|' || COALESCE(host,'(null)') || '|' ||
            COALESCE(host_adapter,'(null)') || '|' ||
            CASE WHEN host_evidence IS NULL THEN 'no' ELSE 'yes' END
       FROM iterations WHERE output_hash='$H' ORDER BY rowid DESC LIMIT 1;")
  IFS='|' read -r sem host adap ev <<<"$ROW"
  printf '   %-30s %-10s %-9s %-18s %s\n' "$(basename "$dir" | cut -c1-30)" "$sem" "$host" "$adap" "$ev"
  [ "$sem" = "$want" ] || { echo "   FAIL  expected host_semantics=$want, the leaf says $sem"; rc=1; }
  seen="$seen $sem"
done
for s in supplied blind declined; do
  case "$seen" in *"$s"*) ;; *) echo "   FAIL  no run produced $s — the three states are not distinct"; rc=1;; esac
done
# ⚑ THE CORRELATION CONTROL, ASKED OF THE WHOLE TABLE. The wrong-id run
# announced a real, complete, schema-valid document about a real scene. No leaf
# anywhere may carry that scene name, because no generation was announced with
# the id it was submitted under. "Says less" is checked above; this is "never
# something false".
WSCENE="$(read_scene "$WRONG")"
if [ -z "$WSCENE" ]; then
  echo "   INCONCLUSIVE  could not read the wrong-id run's scene name"; rc=1
else
  N=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
      "SELECT COUNT(*) FROM iterations WHERE host_evidence LIKE '%$WSCENE%';")
  if [ "$N" = "0" ]; then
    echo "   PASS  no leaf in the database carries '$WSCENE' — the host chose the id and it bought nothing"
  else
    echo "   FAIL  $N leaf/leaves carry a scene announced under a different id"; rc=1
  fi
fi

stage "stage 7 — the audit sweeps"
node scripts/desktop-run.mjs blender-host --url "$APP_URL" --audit || rc=1

stage "stage 8 — WO-D6 still passes with the mutations generalised"
node scripts/desktop-run.mjs host-adapter --url "$APP_URL" || rc=1
node scripts/desktop-run.mjs host-blind   --url "$APP_URL" || rc=1

stage "control — a clean run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs blender-host --url "$APP_URL" --expect-fail >/dev/null 2>&1; then
  echo "   FAIL  a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-E4 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED — the addon is the adapter, and the leaf carries both halves' || echo 'NOT PASSED')"
exit $rc
