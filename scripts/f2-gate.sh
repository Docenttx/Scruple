#!/usr/bin/env bash
# WO-F2 — WitnessWorker.stop() MUST NOT DROP QUEUED CAPTURES.
#
#   npm run f2      (bash scripts/f2-gate.sh)
#
# Finding E7-3 / docs/STATE.md §4.9. `adapter/handlers.WitnessWorker._run()`
# re-checked the stop flag AFTER pulling a job and BEFORE running it, so a
# capture still queued when `stop()` was called never ran — and because it never
# reached the SDK it was not on the SDK's on-disk retry queue either.
# `unregister()` calls `stop()`, so the losing case is a capture taken shortly
# before Blender quits or the add-on is disabled. It bit WO-E7 first: two
# captures reported where the same Blender, waiting for quiescence, reports
# three.
#
# THE GATE: N captures queued and stop() called immediately — all N are either
# delivered or on the durable spool, AND THE COUNT IS READ FROM DISK, not from
# the worker's own accounting. Disk here means two files and nothing else:
#   * the app's SQLite database (`iterations`) for what was delivered;
#   * the SDK's queue JSONL for what was spooled.
# Both are matched by CONTENT HASH, and the hashes are recomputed here with
# sha256sum from the capture files themselves — so the identity of a capture
# never passes through the code under test.
#
# THE CONTROLS:
#   (a) the loss demonstrated RED at the parent commit, WITH THE SAME SCRIPT —
#       the add-on repo's WO-F2 commit is resolved, its parent is checked out
#       into a worktree, and the probe is pointed at that tree;
#   (b) a run with nothing queued must not manufacture a spool entry;
#   (c) a capture that fails for a real reason must still be distinguishable
#       from one that was dropped — a 400 from a server and a file over the
#       inline limit are both PRESENT on the record with their own state, where
#       a dropped capture is present nowhere at all.
#
# STAGE 7 runs the whole thing again inside real Blender, where the trigger is
# `unregister()` on a session being disabled rather than a direct stop().
#
# 🔴 Rails. The only remote this gate dials is the scratch app on :3902 (and
# through it the scratch witness on :5899). Everything else it talks to is a
# loopback stub the probe's own process starts and stops: a closed port, a
# socket that accepts and never answers, and an HTTP server that returns 400.
# Nothing here touches :5799 or :3001. $HOME is redirected so the SDK's key
# cache and spool under ~/.scruple are this gate's and not the box's.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
ADDON="${SCRUPLE_ADDON_REPO:-/data/scruple-blender}"
RUN="$REPO/.run/f2"; mkdir -p "$RUN"
APP="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
DB="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
BLENDER="$REPO/vendor/blender/bin/blender"
N=5

ok=0; fail=0; inconclusive=0
check(){ if [ "$2" = "$3" ]; then printf '   ok    %-66s %s\n' "$1" "$3"; ok=$((ok+1));
         else printf '   FAIL  %-66s got %s want %s\n' "$1" "$3" "$2"; fail=$((fail+1)); fi; }
incon(){ printf '   ????  %-66s %s\n' "$1" "$2"; inconclusive=$((inconclusive+1)); }
note(){ printf '\n══ %s\n' "$1"; }
J(){ python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print('-'); raise SystemExit(0)
cur=d
for k in sys.argv[2].split('.'):
    if cur is None: break
    if isinstance(cur,list): cur=cur[int(k)] if len(cur)>int(k) else None
    else: cur=cur.get(k)
print('-' if cur is None else (json.dumps(cur) if isinstance(cur,(dict,list)) else cur))
" "$1" "$2" 2>/dev/null || echo '-'; }
q(){ sqlite3 "file:$DB?mode=ro" -batch "$1" 2>/dev/null; }

# ⚑ THE ONLY THING THAT COUNTS A CAPTURE IN THIS GATE.
#   digests <dir>            -> the sha256 of every capture file, recomputed here
#   delivered <digests>      -> how many of them are rows in the app's database
#   spooled <queuefile> <ds> -> how many of them are lines in the SDK's queue file
digests(){ [ -d "$1" ] || return 0; find "$1" -type f \( -name '*.png' -o -name '*.blend' \) -print0 \
             | sort -z | xargs -0 -r sha256sum | cut -d' ' -f1; }
# ⚑ `output_hash` is the column. The v2 leaf's `content_hash` lands there —
# `iterations` has no column of that name, and a query against one returns an
# ERROR, not a zero. The first run of this gate scored 9 FAILs on that.
delivered(){ local n=0 h; for h in $1; do
               [ "$(q "SELECT COUNT(*) FROM iterations WHERE output_hash='$h';")" = "1" ] && n=$((n+1)); done; echo "$n"; }
spooled(){ local f="$1" n=0 h; [ -f "$f" ] || { echo 0; return; }
           for h in $2; do grep -qF "\"content_hash\": \"$h\"" "$f" && n=$((n+1)); done; echo "$n"; }
# Not `grep -c`: it EXITS 1 on a count of zero, so `|| echo 0` fires as well
# and the function returns two lines.
lines(){ [ -f "$1" ] || { echo 0; return; }; wc -l < "$1" | tr -d ' '; }

[ -f "$DB" ] || { echo "!! no scratch database at $DB"; exit 2; }
[ -d "$ADDON/.git" ] || { echo "!! no add-on repo at $ADDON"; exit 2; }
node "$REPO/vendor/scruple-web/scripts/preflight-schema.mjs" --apply >"$RUN/preflight.log" 2>&1 \
  || { echo "!! schema preflight failed — see $RUN/preflight.log"; exit 2; }

note "STAGE 0 — what is under test, named rather than described"
echo "   add-on repo   $ADDON @ $(git -C "$ADDON" rev-parse --short HEAD)"
echo "   app           $APP"
echo "   database      $DB"
echo "   schema        $(tail -1 "$RUN/preflight.log")"

AFTER_REF="$(git -C "$ADDON" log --format=%H -1 --grep='^WO-F2:' 2>/dev/null)"
if [ -z "$AFTER_REF" ]; then
  incon "the add-on's WO-F2 commit is resolvable" "no commit whose subject starts WO-F2:"
  BEFORE_REF=""
else
  BEFORE_REF="$(git -C "$ADDON" rev-parse "$AFTER_REF^")"
  echo "   after         $(git -C "$ADDON" rev-parse --short "$AFTER_REF")  $(git -C "$ADDON" log --format=%s -1 "$AFTER_REF")"
  echo "   before        $(git -C "$ADDON" rev-parse --short "$BEFORE_REF")  $(git -C "$ADDON" log --format=%s -1 "$BEFORE_REF")"
fi

KEY="${F2_ADDON_KEY:-}"
if [ -z "$KEY" ]; then
  if [ -f "$REPO/.run/e7/addon-key.json" ]; then
    KEY="$(python3 -c "import json;print(json.load(open('$REPO/.run/e7/addon-key.json'))['apiKey'])")"
  else
    KEY="$(bash scripts/tsx.sh scripts/e7-addon-key.ts --print-key 2>>"$RUN/key.log")"
  fi
fi
[ -n "$KEY" ] || { echo "!! no add-on API key — run scripts/e7-addon-key.ts"; exit 2; }
echo "   add-on key    ${KEY:0:12}…  (the add-on's own tenant, not the desktop's)"

# probe <tree> <mode> <tag> [extra args...]
probe(){
  local tree="$1" mode="$2" tag="$3"; shift 3
  rm -rf -- "${RUN:?}/${tag:?}"
  mkdir -p "$RUN/$tag/work" "$RUN/$tag/cache" "$RUN/$tag/home"
  SCRUPLE_ADDON_REPO="$tree" HOME="$RUN/$tag/home" timeout 600 python3 \
    "$REPO/scripts/f2-worker-spool-probe.py" --mode "$mode" --base-url "$APP" \
    --api-key "$KEY" --work "$RUN/$tag/work" --cache-dir "$RUN/$tag/cache" \
    --n "$N" --out "$RUN/$tag/report.json" "$@" >"$RUN/$tag/probe.log" 2>&1
  [ -s "$RUN/$tag/report.json" ] || echo '{}' > "$RUN/$tag/report.json"
}

# ════════════════════════════════════════════════════════════════════════════
if [ -n "$BEFORE_REF" ]; then
note "STAGE 1 — ⚑ CONTROL (a), RED BEFORE. The parent commit, run by the same probe."
WT="$RUN/before-tree"
git -C "$ADDON" worktree remove --force "$WT" 2>/dev/null || true
rm -rf -- "${RUN:?}/before-tree"
git -C "$ADDON" worktree add -q --detach "$WT" "$BEFORE_REF" 2>>"$RUN/worktree.log"
if [ ! -f "$WT/adapter/handlers.py" ]; then
  incon "the before-tree could be checked out" "see $RUN/worktree.log"
else
  probe "$WT" deliver before-deliver
  echo "   worker source $(J "$RUN/before-deliver/report.json" worker_source)"
  check "the before-tree's stop() has no drain, and no budget to bound one" "False" \
    "$(J "$RUN/before-deliver/report.json" stop_has_drain)"
  check "…and it reports nothing about what it did" "False" \
    "$(J "$RUN/before-deliver/report.json" stop.reported)"
  B_D="$(digests "$RUN/before-deliver/work")"
  B_NFILES="$(echo "$B_D" | grep -c .)"
  check "the before-tree took $N captures and queued them" "$N" "$B_NFILES"
  check "⚑ RED: NONE of them was delivered — counted in the database" "0" "$(delivered "$B_D")"
  check "⚑ RED: …and NONE of them is on the on-disk spool either" "0" \
    "$(spooled "$(J "$RUN/before-deliver/report.json" queue_file)" "$B_D")"
  check "⚑ RED: …the spool file has no lines at all" "0" \
    "$(lines "$(J "$RUN/before-deliver/report.json" queue_file)")"
  check "⚑ RED: …and nothing was recorded about them anywhere" "{}" \
    "$(J "$RUN/before-deliver/report.json" state_counts)"
  echo "   ⚑ that is the finding: on neither disk, and on no record. Silent."

  probe "$WT" offline before-offline
  BO_D="$(digests "$RUN/before-offline/work")"
  check "⚑ RED: with the server unreachable too, the spool stays empty" "0" \
    "$(spooled "$(J "$RUN/before-offline/report.json" queue_file)" "$BO_D")"
  echo "   (store-and-forward could not help: the captures never reached the SDK)"
fi
fi

# ════════════════════════════════════════════════════════════════════════════
note "STAGE 2 — ⚑ THE GATE. $N captures queued, stop() immediately, server up."
probe "$ADDON" deliver after-deliver
R="$RUN/after-deliver/report.json"
echo "   worker source $(J "$R" worker_source)"
echo "   stop          $(J "$R" stop)"
check "the worker under test is the shipped class" "adapter.handlers.WitnessWorker" \
  "$(J "$R" worker_class)"
check "it attached against the sandbox before anything was broken" "True" "$(J "$R" attached)"
check "$N captures plus the hold were still queued when stop() was called" "$((N+1))" \
  "$(J "$R" queued_before_stop)"
A_D="$(digests "$RUN/after-deliver/work")"
check "…and $N capture files exist to be counted independently" "$N" "$(echo "$A_D" | grep -c .)"
A_DEL="$(delivered "$A_D")"
A_SPL="$(spooled "$(J "$R" queue_file)" "$A_D")"
echo "   from disk:    delivered $A_DEL   spooled $A_SPL   (of $N)"
check "⚑ THE GATE: delivered + spooled = every capture that was queued" "$N" "$((A_DEL + A_SPL))"
check "…and with the server up they were DELIVERED, counted in the database" "$N" "$A_DEL"
check "…so nothing was left on the spool" "0" "$A_SPL"
check "…and stop() abandoned nothing" "[]" "$(J "$R" stop.abandoned)"

note "STAGE 3 — the same gate with the server unreachable: the spool, not the floor."
probe "$ADDON" offline after-offline
R3="$RUN/after-offline/report.json"
O_D="$(digests "$RUN/after-offline/work")"
O_DEL="$(delivered "$O_D")"; O_SPL="$(spooled "$(J "$R3" queue_file)" "$O_D")"
echo "   submit url    $(J "$R3" submit_url)  (a port nothing is listening on)"
echo "   from disk:    delivered $O_DEL   spooled $O_SPL   (of $N)"
check "⚑ delivered + spooled = every capture that was queued" "$N" "$((O_DEL + O_SPL))"
check "…all of them on the SPOOL, which is where an outage puts them" "$N" "$O_SPL"
check "…and the spool file has exactly that many lines" "$N" "$(lines "$(J "$R3" queue_file)")"
check "…each one recorded as queued, not as delivered" "{\"queued\": $N}" "$(J "$R3" state_counts)"

note "STAGE 4 — the bound. A server that accepts and never answers."
probe "$ADDON" hang after-hang
R4="$RUN/after-hang/report.json"
H_D="$(digests "$RUN/after-hang/work")"
H_SPL="$(spooled "$(J "$R4" queue_file)" "$H_D")"
WALL="$(J "$R4" stop_wall_seconds)"
BOUND="$(python3 -c "print($(J "$R4" drain_seconds) + $(J "$R4" shutdown_timeout) + $(J "$R4" hurry_seconds))" 2>/dev/null || echo 0)"
echo "   budgets       drain $(J "$R4" drain_seconds)s + one request at $(J "$R4" shutdown_timeout)s + hurry $(J "$R4" hurry_seconds)s = ${BOUND}s"
echo "   stop() took   ${WALL}s   hurried=$(J "$R4" stop.hurried)"
check "⚑ every capture reached the spool even so" "$N" "$H_SPL"
check "…stop() abandoned nothing" "[]" "$(J "$R4" stop.abandoned)"
check "…it did have to cut the network budget, so the phase was exercised" "True" \
  "$(J "$R4" stop.hurried)"
check "…and it held Blender inside the declared bound" "yes" \
  "$(python3 -c "print('yes' if $WALL <= $BOUND else 'no')" 2>/dev/null || echo '?')"
check "…the budget was cut to the hurry value and left there for the session end" \
  "0.1" "$(J "$R4" timeout_after_stop)"

note "STAGE 4B — ⚑ FINDING F2-1: the one request already on the wire when stop() is called."
# The bound covers every request that STARTS after stop(). It cannot cover one
# that was already blocked in read(): `http.submit()` hands `session.timeout` to
# `urlopen` and there is no cancel. This stage puts a capture on the wire
# against the wedged server, leaves it there, queues four more behind it, and
# then stops — so the residual risk is MEASURED rather than argued. What the fix
# owes here is not zero loss; it is that the loss is NAMED.
probe "$ADDON" inflight after-inflight
R4B="$RUN/after-inflight/report.json"
I_D="$(digests "$RUN/after-inflight/work")"
I_DEL="$(delivered "$I_D")"; I_SPL="$(spooled "$(J "$R4B" queue_file)" "$I_D")"
ABN="$(python3 -c "
import json;d=json.load(open('$R4B'));a=(d.get('stop') or {}).get('abandoned') or []
print(len(a))" 2>/dev/null || echo 0)"
echo "   the first capture went on the wire with a $(J "$R4B" inflight_timeout)s budget and stayed there"
echo "   stop() took   $(J "$R4B" stop_wall_seconds)s   hurried=$(J "$R4B" stop.hurried)   abandoned=$ABN"
echo "   from disk:    delivered $I_DEL   spooled $I_SPL   (of $N)"
check "⚑ F2-1 IS REAL: the drain could not reach every capture" "yes" \
  "$([ "$ABN" -gt 0 ] && echo yes || echo no)"
check "…and stop() still returned inside its OWN bound, so Blender is not wedged" "yes" \
  "$(python3 -c "print('yes' if $(J "$R4B" stop_wall_seconds) <= $(J "$R4B" drain_seconds) + $(J "$R4B" hurry_seconds) + 1 else 'no')" 2>/dev/null || echo '?')"
check "⚑ every capture it could not reach is NAMED, not counted" "yes" \
  "$(python3 -c "
import json;d=json.load(open('$R4B'));a=(d.get('stop') or {}).get('abandoned') or []
print('yes' if a and all(x.startswith('render_write ') for x in a) else 'no')" 2>/dev/null || echo no)"
check "…and disk agrees with the report: delivered + spooled + abandoned = $N" "$N" \
  "$((I_DEL + I_SPL + ABN))"
echo "   ⚑ this is the residual the work order cannot close from the adapter."
echo "     Closing it needs a cancellable transport in the SDK — see docs/WO-F2.md F2-1."

note "STAGE 5 — CONTROL (b): nothing queued must not manufacture a spool entry."
probe "$ADDON" empty after-empty
R5="$RUN/after-empty/report.json"
check "the run attached, so it COULD have written a spool entry" "True" "$(J "$R5" attached)"
check "nothing was queued" "0" "$(J "$R5" queued_before_stop)"
check "⚑ the spool file has no lines" "0" "$(lines "$(J "$R5" queue_file)")"
check "…and nothing was recorded as a capture" "{}" "$(J "$R5" state_counts)"
check "…stop() says so rather than inventing work" "0" "$(J "$R5" stop.ran)"

note "STAGE 6 — CONTROL (c): a real failure is not a drop, and reads differently."
probe "$ADDON" reject after-reject
R6="$RUN/after-reject/report.json"
J_D="$(digests "$RUN/after-reject/work")"
echo "   submit url    $(J "$R6" submit_url)  (a stub that answers 400)"
check "⚑ each capture is PRESENT on the record, as rejected" "{\"rejected\": $N}" \
  "$(J "$R6" state_counts)"
check "…naming the reason the server gave" "HTTP 400" "$(J "$R6" captures.0.error)"
check "…carrying the content hash, so it can be re-taken" "yes" \
  "$([ "$(J "$R6" captures.0.content_hash)" != "-" ] && echo yes || echo no)"
check "…NOT queued — the SDK spools transport failures and 5xx only" "0" \
  "$(spooled "$(J "$R6" queue_file)" "$J_D")"
check "…and not delivered either" "0" "$(delivered "$J_D")"

probe "$ADDON" oversize after-oversize
R7="$RUN/after-oversize/report.json"
check "⚑ a local refusal is present too, under its own state" '{"refused_locally": 1}' \
  "$(J "$R7" state_counts)"
check "…naming what the add-on refused and why" "yes" \
  "$(J "$R7" captures.0.error | grep -q 'inline limit' && echo yes || echo no)"
check "…and it never reached the wire, so nothing is spooled" "0" \
  "$(lines "$(J "$R7" queue_file)")"
echo "   ⚑ the contrast: a dropped capture had NO state, NO hash and NO row"
echo "     anywhere (stage 1). A failed one has all three."

# ════════════════════════════════════════════════════════════════════════════
note "STAGE 7 — ⚑ THE SAME THING IN REAL BLENDER, on the path that bit WO-E7."
if [ ! -x "$BLENDER" ]; then
  incon "Blender is available" "no Blender at $BLENDER — run scripts/e3-install-blender.sh"
else
echo "   blender       $("$BLENDER" --version 2>/dev/null | head -1)"
bl_build(){ ( cd "$1" && SCRUPLE_WEB_ROOT=/nonexistent bash build/build_addon.sh ) >"$RUN/build-$2.log" 2>&1
            ls "$1"/dist/scruple-blender-*.zip 2>/dev/null | head -1; }
bl_run(){ # bl_run <zip> <tag>
  local zip="$1" tag="$2"
  rm -rf -- "${RUN:?}/bl-${tag:?}"
  mkdir -p "$RUN/bl-$tag/profile" "$RUN/bl-$tag/home" "$RUN/bl-$tag/work"
  BLENDER_USER_RESOURCES="$RUN/bl-$tag/profile" HOME="$RUN/bl-$tag/home" timeout 900 "$BLENDER" \
    --command extension install-file -r user_default -e "$zip" >"$RUN/bl-$tag/install.log" 2>&1
  BLENDER_USER_RESOURCES="$RUN/bl-$tag/profile" HOME="$RUN/bl-$tag/home" timeout 1200 "$BLENDER" \
    --background --python "$REPO/scripts/f2-blender-quit.py" -- \
    --api-key "$KEY" --base-url "$APP" --work "$RUN/bl-$tag/work" --n 4 >"$RUN/bl-$tag/run.log" 2>&1
  sed -n '/<<<F2_BLENDER/,/F2_BLENDER>>>/p' "$RUN/bl-$tag/run.log" | sed '1d;$d' > "$RUN/bl-$tag/report.json"
  [ -s "$RUN/bl-$tag/report.json" ] || echo '{}' > "$RUN/bl-$tag/report.json"
}

AFTER_ZIP="$(bl_build "$ADDON" after)"
if [ -z "$AFTER_ZIP" ]; then
  incon "the add-on packaged" "see $RUN/build-after.log"
else
  bl_run "$AFTER_ZIP" after
  BR="$RUN/bl-after/report.json"
  echo "   module        $(J "$BR" module)"
  echo "   stop          $(J "$BR" stop)"
  check "the add-on is installed and its Settings UI binds (WO-F1)" "True" \
    "$(J "$BR" preferences_bound)"
  check "…and it is the WO-F2 worker that is running" "True" "$(J "$BR" stop_has_drain)"
  check "the worker was held, so the saves really did queue behind it" "True" \
    "$(J "$BR" worker_held)"
  BLN="$(J "$BR" queued_before_stop)"
  echo "   queued when the add-on was disabled: $BLN"
  if [ "$BLN" = "-" ] || [ "${BLN:-0}" -lt 2 ] 2>/dev/null; then
    incon "the Blender stage had teeth" "only $BLN job(s) queued at unregister()"
  else
    BL_D="$(digests "$RUN/bl-after/work")"
    BL_DEL="$(delivered "$BL_D")"; BL_SPL="$(spooled "$(J "$BR" queue_file)" "$BL_D")"
    echo "   from disk:    delivered $BL_DEL   spooled $BL_SPL   (of 4 saved .blends)"
    check "⚑ unregister() lost nothing: delivered + spooled = every save" "4" \
      "$((BL_DEL + BL_SPL))"
    check "…and stop() abandoned nothing" "[]" "$(J "$BR" stop.abandoned)"
    check "…the error surface is clean of 'not taken'" "no" \
      "$(J "$BR" last_error | grep -qi 'not taken' && echo yes || echo no)"
  fi

  if [ -n "$BEFORE_REF" ] && [ -f "$RUN/before-tree/adapter/handlers.py" ]; then
    BEFORE_ZIP="$(bl_build "$RUN/before-tree" before)"
    if [ -z "$BEFORE_ZIP" ]; then
      incon "the before-tree packaged for Blender" "see $RUN/build-before.log"
    else
      bl_run "$BEFORE_ZIP" before
      BB="$RUN/bl-before/report.json"
      echo "   before: module $(J "$BB" module)  queued $(J "$BB" queued_before_stop)"
      check "the before-tree is the one without a drain" "False" "$(J "$BB" stop_has_drain)"
      # The RED is only worth anything if the run was otherwise identical: same
      # install path, same configured session, same four saves, worker held.
      check "…installed and configured the same way" "True" "$(J "$BB" preferences_bound)"
      check "…pointed at the same sandbox" "$APP" "$(J "$BB" client_base_url)"
      check "…held its worker the same way" "True" "$(J "$BB" worker_held)"
      check "…and wrote the same four .blends" "[true, true, true, true]" "$(J "$BB" saved)"
      echo "   before: unregister() took $(J "$BB" unregister_seconds)s and recorded $(J "$BB" state_counts)"
      BB_D="$(digests "$RUN/bl-before/work")"
      BB_DEL="$(delivered "$BB_D")"; BB_SPL="$(spooled "$(J "$BB" queue_file)" "$BB_D")"
      echo "   from disk:    delivered $BB_DEL   spooled $BB_SPL   (of 4 saved .blends)"
      check "⚑ RED IN BLENDER: disabling the add-on lost captures" "yes" \
        "$([ "$((BB_DEL + BB_SPL))" -lt 4 ] && echo yes || echo no)"
      echo "   ⚑ WO-E7 measured this as two captures where there were three."
    fi
  fi
fi
fi

note "STAGE 8 — CONTROL: the add-on's own suite"
( cd "$ADDON" && timeout 1800 python3 -m pytest -q ) > "$RUN/pytest.log" 2>&1
PYT=$?
tail -1 "$RUN/pytest.log" | sed 's/^/   /'
check "the add-on suite is green" "0" "$PYT"

note "RESULT"
printf '   ok %d   fail %d   inconclusive %d\n' "$ok" "$fail" "$inconclusive"
if [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]; then
  echo "   WO-F2 GATE: PASS"
elif [ "$fail" -eq 0 ]; then
  echo "   WO-F2 GATE: INCONCLUSIVE — an inconclusive control is never a pass"
  exit 1
else
  echo "   WO-F2 GATE: FAIL"
  exit 1
fi
