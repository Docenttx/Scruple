#!/usr/bin/env bash
# WO-D3 gate. One command, non-zero if anything misbehaves.
#
#   stage 0  the sandbox — a key, a baseline over app/vault's own source, a token
#   stage 1  the STATIC control: no extension→MIME logic exists in the surface
#   stage 2  the control RED BEFORE THE CHANGE — the legacy loop, run over the
#            same directory, showing both WO-D3 controls failing on the old code
#   the gate a real directory of files produces leaves in the scratch witness
#   stage 4  those leaves re-hashed FROM THE SHELL, independently of node
#   stage 5  the audit sweep — every mutation must redden exactly what it targets
#   control A  the undeclared MIME refusal, shown to be caused by the declaration
#   control B  the over-ceiling refusal, shown to be caused by the ceiling
#   control C  a passing run must NOT satisfy --expect-fail
#
# Nothing here reads a log line and nothing reads a pixel (docs/DESIGN.md:
# llvmpipe returns a blank frame).
set -uo pipefail
cd "$(dirname "$0")/.."
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
rc=0

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }

stage "stage 0 — the sandbox"
bash scripts/tsx.sh scripts/d3-sandbox.ts || { echo "   sandbox failed"; exit 2; }

stage "stage 1 — STATIC control: nothing in the surface decides a MIME from a name"
# The estate's own discipline, applied here: "there is no `mimetypes` import
# anywhere in this package". Comment lines are excluded because the argument
# for the rule is written in them.
hits=$(grep -nE "extname|mimetypes|endsWith\('\.|guess_type|octet-stream" app/vault/*.ts \
        | grep -vE "^[^:]+:[0-9]+: *(//|\*)" || true)
if [ -n "$hits" ]; then
  echo "   FAIL — the surface can name a type from a filename:"; echo "$hits"; rc=1
else
  echo "   PASS  no extension table, no mimetypes, no octet-stream default in app/vault/"
fi

stage "stage 2 — the control RED BEFORE the change (app-legacy/lock/lock-local-lock.js)"
# Needs a materialised vault. The clean run below makes one; use the newest, or
# make one first if this is a cold start.
# ⚑ SELECTED BY WHAT IS IN IT, NOT BY WHAT IT IS CALLED. This used to glob
# `*/source/training-vault` and take the newest, which quietly meant "any
# scenario that happens to name a vault fixture the same thing" — WO-D7's
# full-flow did, its vault has no oversize.json, and stage 2's ceiling control
# reported NOT DEMONSTRATED against a directory that was never D3's. The
# fixture was renamed, and this now requires the file the control actually
# needs, so the next collision cannot happen at all.
newest_vault(){
  for d in $(ls -dt .run/d2/*/source/*vault* 2>/dev/null); do
    [ -f "$d/oversize.json" ] && [ -f "$d/opaque.bin" ] && [ -f "$d/undeclared.png" ] || continue
    echo "$d"; return
  done
}
if [ -z "$(newest_vault)" ]; then
  echo "   (no vault fixture yet — running the scenario once to make one)"
  node scripts/desktop-run.mjs vault-capture --url "$APP_URL" >/dev/null 2>&1
fi
V="$(newest_vault)"; RD="$(dirname "$(dirname "$V")")"
M="$(ls "$RD"/store/*.vault-manifest.json 2>/dev/null | head -1)"
node scripts/d3-legacy-contrast.mjs "$V" "$M" || rc=1

stage "the gate — a real directory of files, through the real IPC seam"
echo "\$ node scripts/desktop-run.mjs vault-capture"
node scripts/desktop-run.mjs vault-capture --url "$APP_URL" || rc=1

stage "stage 4 — those leaves, re-hashed FROM THE SHELL"
# Independent of node, of the app and of the sidecar: sha256sum reads the bytes,
# sqlite3 reads the witness server's own database, and the two are compared here.
V="$(newest_vault)"; RD="$(dirname "$(dirname "$V")")"
M="$(ls "$RD"/store/*.vault-manifest.json 2>/dev/null | head -1)"
printf '   %-24s %-66s %s\n' file sha256 'in scratch witness?'
for f in "$V"/accepted.png "$V"/config.toml "$M"; do
  h=$(sha256sum "$f" | cut -d' ' -f1)
  n=$(sqlite3 "file:$SCRUPLE_WITNESS_DB?mode=ro" -batch "SELECT count(*) FROM witnesses WHERE content_hash='$h';")
  printf '   %-24s %s %s\n' "$(basename "$f")" "$h" "$([ "$n" -ge 1 ] && echo "YES ($n)" || echo 'NO')"
  [ "$n" -ge 1 ] || rc=1
done
echo "   and the refused ones, which must have NO leaf:"
for f in "$V"/undeclared.png "$V"/opaque.bin "$V"/oversize.json; do
  h=$(sha256sum "$f" | cut -d' ' -f1)
  n=$(sqlite3 "file:$SCRUPLE_WITNESS_DB?mode=ro" -batch "SELECT count(*) FROM witnesses WHERE content_hash='$h';")
  printf '   %-24s %s %s\n' "$(basename "$f")" "$h" "$([ "$n" -eq 0 ] && echo 'absent — correct' || echo "PRESENT ($n) — WRONG")"
  [ "$n" -eq 0 ] || rc=1
done
echo "   and the basis every one of them was written under:"
sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch -header \
  "SELECT id, substr(output_hash,1,16) AS content_hash, witnessed, attestation_basis, attestation_profile,
          component_verified, mime_declared
     FROM iterations WHERE attestation_profile='desktop' ORDER BY rowid DESC LIMIT 6;" | sed 's/^/   /'
bad=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
  "SELECT count(*) FROM iterations WHERE attestation_profile='desktop' AND attestation_basis='verified';")
if [ "$bad" != "0" ]; then echo "   FAIL — $bad desktop leaves claim 'verified'"; rc=1
else echo "   PASS  no desktop leaf claims 'verified' — it is unrepresentable here by construction"; fi

stage "stage 5 — the audit sweep"
node scripts/desktop-run.mjs vault-capture --url "$APP_URL" --audit || rc=1

stage "control A — declare the undeclared file; the refusal must STOP (must exit non-zero)"
node scripts/desktop-run.mjs vault-capture --url "$APP_URL" --break declare-the-undeclared --expect-fail || rc=1

stage "control B — raise the ceiling; the refusal must STOP (must exit non-zero)"
node scripts/desktop-run.mjs vault-capture --url "$APP_URL" --break raise-the-ceiling --expect-fail || rc=1

stage "control C — the clean run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs vault-capture --url "$APP_URL" --expect-fail >/dev/null 2>&1; then
  echo "   a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-D3 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED, every mutation caught, all controls fired' || echo 'NOT PASSED')"
exit $rc
