#!/usr/bin/env bash
# WO-D5 gate. One command, non-zero if anything misbehaves.
#
#   stage 0   the rails, and the canon source is byte-identical to the canon
#   stage 1   the RED BEFORE, read out of git rather than remembered: the
#             shared theme carried zero canon tokens and hard-coded the palette
#   stage 2   the port — 20 tokens declared, the 21st still undeclared, both
#             layouts scoped, and the file regenerates to itself
#   the gate  the SAME route renders both shapes: the desktop one in a real
#             Electron window under xvfb, the web one fetched from the shell
#   stage 4   the canon design measured by the layout engine, not by a pixel
#   stage 5   the audit sweep — every mutation reddens exactly what it targets
#   control A the theme drift check: move one channel and the port goes red
#   control B absent, not empty — counted in the served bytes, both directions
#   control C an unknown profile is REFUSED, never coerced to a shape
#   control D a passing run must NOT satisfy --expect-fail
#   control E the server's own suites for the theme and the shape
#
# Nothing here reads a log line and nothing reads a pixel (docs/DESIGN.md:
# llvmpipe returns a blank frame, verified three ways).
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
export SCRUPLE_APP_URL="$APP_URL"
export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
export SCRUPLE_WITNESS_DB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
export SCRUPLE_BDK_ALLOW_DEV="${SCRUPLE_BDK_ALLOW_DEV:-1}"
rc=0

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }
ok(){   printf '   ok    %s\n' "$1"; }
bad(){  printf '   FAIL  %s\n' "$1"; rc=1; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — got '$2', wanted '$3'"; fi; }

CANON="$REPO/app-legacy/renderer/styles"
SRC="$WEB/app/theme/canon-source"
THEME="$WEB/app/theme/canon.css"

stage "stage 0 — the canon source in the shared repo IS the canon"
# A port whose source drifted from the original is a fork with a comment on it.
for f in main.css wallet.css; do
  a=$(sha256sum < "$CANON/$f" | cut -d' ' -f1)
  b=$(sha256sum < "$SRC/$f" | cut -d' ' -f1)
  check "$f byte-identical across the two repos" "$a" "$b"
done

stage "stage 1 — the RED BEFORE, read out of git"
# docs/DESIGN.md: "the two share ZERO tokens today". This is that sentence,
# measured against the commit this WO started from rather than recalled.
#
# ⚑ FIXED BY WO-D6, AND THE BUG IS WORTH THE PARAGRAPH. This read
# `HEAD:tailwind.config.ts`, which WAS the pre-change tree while WO-D5's work
# was uncommitted — and stopped being it the instant WO-D5 committed. The gate
# passed once, at the only moment it could, and then went red forever on a
# repository that had not regressed at all. A control pinned to a moving
# reference measures the reference.
#
# The before-tree is now resolved from the change itself: the parent of the
# commit that first added app/theme/canon.css. That commit cannot move, so the
# comparison keeps meaning the same thing however many work orders land after it.
D5_COMMIT=$(git -C "$WEB" log --diff-filter=A --format=%H -- app/theme/canon.css | tail -1)
BEFORE_REF="${D5_COMMIT:+$D5_COMMIT^}"
BEFORE_REF="${BEFORE_REF:-HEAD}"
echo "   (the before-tree is $BEFORE_REF — the parent of the commit that added canon.css)"
before_tokens=$(git -C "$WEB" show "$BEFORE_REF:app/globals.css" 2>/dev/null | grep -c -- '--bg-primary')
before_hex=$(git -C "$WEB" show "$BEFORE_REF:tailwind.config.ts" 2>/dev/null | grep -c -- '#00d9ff')
check "canon tokens in the shared theme BEFORE" "$before_tokens" "0"
[ "$before_hex" -ge 1 ] && ok "the palette was hard-coded BEFORE ($before_hex literal #00d9ff in tailwind.config.ts)" \
  || bad "expected the pre-change tailwind config to hard-code the palette"
after_hex=$(grep -c -- '#00d9ff' "$WEB/tailwind.config.ts")
check "canon hex literals in tailwind.config.ts AFTER" "$after_hex" "0"
after_tokens=$(grep -c -- '--bg-primary-rgb' "$THEME")
[ "$after_tokens" -ge 1 ] && ok "the theme declares the canon tokens AFTER" || bad "no canon tokens in the theme"

stage "stage 2 — the port"
( cd "$WEB" && node scripts/port-canon-css.mjs --check ) >/dev/null 2>&1 \
  && ok "canon.css regenerates to itself — it is derived, not maintained" \
  || bad "canon.css has drifted from what canon-source/ ports to"
declared=$(sed -n '/:root {/,/^}/p' "$CANON/main.css" | grep -cE '^\s*--[a-z-]+:')
check "tokens the canon declares" "$declared" "20"
grep -q -- '--accent-hover' "$CANON/main.css" \
  && ok "the 21st token is REFERENCED by the canon" || bad "--accent-hover is gone from the canon"
if grep -qE '^\s*--accent-hover\s*:' "$THEME"; then
  bad "the theme DECLARED --accent-hover — that is a repair, and a repair is a restyle"
else
  ok "the 21st token is still undeclared in the theme — the defect came across as a defect"
fi
ws=$(grep -c '^\.scruple-canon\.workspace' "$THEME"); wl=$(grep -c '^\.scruple-canon\.wallet' "$THEME")
[ "$ws" -gt 100 ] && ok "the workspace layout came across ($ws rules)" || bad "workspace layout thin: $ws rules"
[ "$wl" -gt 40 ] && ok "the wallet layout came across ($wl rules)" || bad "wallet layout thin: $wl rules"
leaked=$(grep -cE '^\.[a-z][a-z0-9-]*[ ,{]' "$THEME")
check "canon rules that escaped the scope" "$leaked" "0"

stage "the gate — one route, two shapes, the desktop one in a real window"
timeout 600 node scripts/desktop-run.mjs dashboard-shape 2>&1 | tail -6
[ "${PIPESTATUS[0]}" = "0" ] && ok "the desktop shape rendered in Electron under xvfb" || bad "the scenario failed"

stage "stage 4 — the SAME route, both shapes, fetched from the shell"
# Independent of node, of the driver and of the app: curl and grep.
d=$(curl -s -m 60 -H 'x-scruple-profile: desktop' "$APP_URL/studio")
w=$(curl -s -m 60 -H 'x-scruple-profile: web'     "$APP_URL/studio")
for r in local-apps capture-gate vault model-store; do
  n=$(printf '%s' "$d" | grep -c "data-region=\"$r\""); [ "$n" -ge 1 ] && ok "desktop draws $r" || bad "desktop is missing $r"
done
for r in cloud-compute machine-tiers billing; do
  n=$(printf '%s' "$w" | grep -c "data-region=\"$r\""); [ "$n" -ge 1 ] && ok "web draws $r" || bad "web is missing $r"
done
for r in projects attestation; do
  a=$(printf '%s' "$d" | grep -c "data-region=\"$r\""); b=$(printf '%s' "$w" | grep -c "data-region=\"$r\"")
  { [ "$a" -ge 1 ] && [ "$b" -ge 1 ]; } && ok "both shapes draw $r — one component tree" || bad "$r is not on both shapes"
done

stage "control B — ABSENT, not empty, counted in the served bytes"
# The WO's own control. Not "no visible node" — no OCCURRENCE anywhere in the
# document, which is the only form that catches a region drawn and hidden.
for r in cloud-compute machine-tiers 'data-region="billing"'; do
  check "occurrences of '$r' in the desktop document" "$(printf '%s' "$d" | grep -o "$r" | wc -l)" "0"
done
for r in local-apps capture-gate model-store; do
  check "occurrences of '$r' in the web document" "$(printf '%s' "$w" | grep -o "$r" | wc -l)" "0"
done

stage "control C — an unknown profile is refused, never coerced"
b=$(curl -s -m 60 -H 'x-scruple-profile: desktopp' "$APP_URL/studio")
check "regions drawn for a typo'd profile" "$(printf '%s' "$b" | grep -o 'data-region="[a-z-]*"' | grep -cv refusal)" "0"
printf '%s' "$b" | grep -q 'Unknown deployment profile' \
  && ok "it says why rather than rendering the web shape" || bad "a typo'd profile did not produce a refusal"
check "the API refuses it too" \
  "$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/api/v2/capabilities?profile=desktopp")" "400"

stage "control A — theme drift: move one channel and the port must go red"
cp "$THEME" "$THEME.gate-backup"
restore(){ [ -f "$THEME.gate-backup" ] && mv "$THEME.gate-backup" "$THEME"; }
trap restore EXIT
sed -i 's/--accent-primary-rgb: 0 217 255;/--accent-primary-rgb: 0 217 254;/' "$THEME"
if ( cd "$WEB" && node scripts/port-canon-css.mjs --check ) >/dev/null 2>&1; then
  bad "one channel moved and the drift check still passed — the check is worthless"
else
  ok "one channel moved and the drift check went RED"
fi
if ( cd "$WEB" && SCRUPLE_DB_PATH=$(mktemp -d)/t.db node --import tsx --test test/v2/canon-theme.test.ts ) >/dev/null 2>&1; then
  bad "the theme test passed against a mutated token"
else
  ok "the theme test went RED against a mutated token"
fi
restore; trap - EXIT
( cd "$WEB" && node scripts/port-canon-css.mjs --check ) >/dev/null 2>&1 \
  && ok "restored — the theme is current again" || bad "restore failed; the theme is left mutated"

stage "control D — a passing run must NOT satisfy --expect-fail"
timeout 600 node scripts/desktop-run.mjs dashboard-shape --expect-fail >/dev/null 2>&1
check "--expect-fail on a clean run" "$?" "1"

stage "control E — the server's own suites"
suite_out=$( cd "$WEB" && SCRUPLE_DB_PATH=$(mktemp -d)/t.db node --import tsx --test test/v2/canon-theme.test.ts test/v2/deployment-shape.test.ts 2>&1 )
suite_rc=$?
printf '%s\n' "$suite_out" | grep -E '^# (tests|pass|fail)'
[ "$suite_rc" = "0" ] && ok "theme + shape suites green" || bad "a server suite is red"

stage "stage 5 — the audit sweep"
timeout 2400 node scripts/desktop-run.mjs dashboard-shape --audit 2>&1 | tail -9
[ "${PIPESTATUS[0]}" = "0" ] && ok "every mutation caught by exactly what it targets" || bad "the sweep is not clean"

printf '\n════ WO-D5 %s ════\n' "$([ $rc = 0 ] && echo 'GATE PASSED' || echo 'GATE FAILED')"
exit $rc
