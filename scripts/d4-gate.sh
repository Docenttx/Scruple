#!/usr/bin/env bash
# WO-D4 gate. One command, non-zero if anything misbehaves.
#
#   stage 0  the sandbox — a key and a baseline over app/comfy's OWN source
#   stage 1  the STATIC control: no second implementation of the preimage
#   stage 2  the control RED BEFORE THE CHANGE — modal/scruple_runner.py's own
#            functions, sliced out and run over this model store, with both
#            defects showing
#   the gate a generation through the gate produces a leaf carrying model
#            fingerprints computed from the FILES
#   stage 4  that fingerprint, re-derived FROM THE SHELL — sha256sum reads the
#            model file, sqlite3 reads the leaf, and bash compares them
#   stage 5  the audit sweep — every mutation reddens exactly what it targets
#   control A  the model swap: same name, same length, same header, new weights
#   control B  the same gate with no host adapter — the fingerprints stop
#   control C  the same generation around the gate — the enrichment stops
#   control D  ComfyUI on 0.0.0.0 — the ledger's loopback reading moves
#   control E  a passing run must NOT satisfy --expect-fail
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
newest_store(){ ls -dt .run/d2/*/source/comfy-base/models 2>/dev/null | head -1; }

stage "stage 0 — the sandbox, baselined over app/comfy/"
bash scripts/tsx.sh scripts/d3-sandbox.ts --surface app/comfy || { echo "   sandbox failed"; exit 2; }

stage "stage 1 — STATIC control: the preimage is imported, never reimplemented"
# /api/v2/witness recomputes model_fingerprints_hash from the manifest and
# REFUSES a submission whose halves disagree, so a hand-rolled preimage cannot
# ship green — but it can ship, fail obscurely, and be debugged for an hour.
# The rule is checked where it is cheap.
if grep -q "hashModelFingerprints" app/comfy/modelSink.ts && grep -q "hashModelFingerprints" app/comfy/sdk.ts; then
  echo "   PASS  hashModelFingerprints comes from lib/leaf/hashes.ts"
else
  echo "   FAIL  the adapter does not import the SDK's hash function"; rc=1
fi
hits=$(grep -nE "canonicalize\(|JSON\.stringify\(.*fingerprint" app/comfy/*.ts \
        | grep -vE "^[^:]+:[0-9]+: *(//|\*)" || true)
if [ -n "$hits" ]; then
  echo "   FAIL — app/comfy canonicalises a fingerprint manifest itself:"; echo "$hits"; rc=1
else
  echo "   PASS  no local canonicalization of the manifest anywhere in app/comfy/"
fi

stage "stage 2 — the control RED BEFORE the change (modal/scruple_runner.py)"
if [ -z "$(newest_store)" ]; then
  echo "   (no model store fixture yet — running the scenario once to make one)"
  node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" >/dev/null 2>&1
fi
MR="$(newest_store)"
LEAFMANIFEST="$(mktemp)"
# The manifest the newest desktop leaf carries, pulled straight out of the app
# database so the contrast is against what actually shipped.
sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
  "SELECT model_fingerprints FROM iterations
    WHERE model_fingerprints IS NOT NULL AND model_fingerprints LIKE '%upscale_models%'
    ORDER BY rowid DESC LIMIT 1;" > "$LEAFMANIFEST"
python3 scripts/d4-python-contrast.py "$MR" "$LEAFMANIFEST" || rc=1
rm -f "$LEAFMANIFEST"

stage "the gate — a generation through the gate, and what its leaf carries"
echo "\$ node scripts/desktop-run.mjs comfy-generate"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" || rc=1

stage "stage 4 — the fingerprint, re-derived FROM THE SHELL"
# Independent of node, of the app, of the gate and of the sidecar: sha256sum
# reads the model file, sqlite3 reads the leaf, and the comparison is here.
RD="$(ls -dt .run/d2/clean-* | head -1)"
MR="$RD/source/comfy-base/models"
MODEL="$MR/upscale_models/scruple-tiny-x2.safetensors"
OUT=$(python3 -c "
import json,sys
r=json.load(open('$RD/result.json'))
i=r['steps']['gen']['value']['images'][0]
print(i['sha256'], i['storePath'])
")
OUTHASH=$(echo "$OUT" | cut -d' ' -f1); OUTPATH=$(echo "$OUT" | cut -d' ' -f2)
MH=$(sha256sum "$MODEL" | cut -d' ' -f1)
LH=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
  "SELECT json_extract(model_fingerprints, '\$.\"upscale_models/scruple-tiny-x2.safetensors\".content_hash')
     FROM iterations WHERE output_hash='$OUTHASH' ORDER BY rowid DESC LIMIT 1;")
printf '   %-26s %s\n' "model file on disk"      "$MH"
printf '   %-26s %s\n' "content_hash on the leaf" "$LH"
if [ "$MH" = "$LH" ] && [ -n "$LH" ]; then
  echo "   PASS  the leaf's fingerprint IS a digest of the bytes in this model store"
else
  echo "   FAIL  the leaf's fingerprint does not match the file"; rc=1
fi
AH=$(sha256sum "$OUTPATH" | cut -d' ' -f1)
printf '   %-26s %s\n' "artifact on disk" "$AH"
[ "$AH" = "$OUTHASH" ] || { echo "   FAIL  the stored artifact does not re-hash"; rc=1; }
WN=$(sqlite3 "file:$SCRUPLE_WITNESS_DB?mode=ro" -batch "SELECT count(*) FROM witnesses WHERE content_hash='$OUTHASH';")
printf '   %-26s %s\n' "leaves in scratch witness" "$WN"
[ "$WN" -ge 1 ] || { echo "   FAIL  no leaf for the artifact"; rc=1; }

echo "   and the manifest carries no timestamp — so a holder of the weights can recompute the digest:"
if sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
     "SELECT model_fingerprints FROM iterations WHERE output_hash='$OUTHASH' ORDER BY rowid DESC LIMIT 1;" \
     | python3 -c "
import json,sys,re
m=json.load(sys.stdin)
bad=[(k,f) for k,v in m.items() for f in v if re.search(r'time|mtime|_at\$', f)]
print('   ' + ('FAIL  time-varying fields: '+str(bad) if bad else 'PASS  no time-varying field in any entry'))
sys.exit(1 if bad else 0)"; then :; else rc=1; fi

echo "   and the basis every leaf here was written under:"
sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch -header \
  "SELECT substr(output_hash,1,16) AS content_hash, witnessed, attestation_basis, attestation_profile,
          component_verified, substr(model_fingerprints_hash,1,16) AS mf_hash
     FROM iterations WHERE output_hash='$OUTHASH' ORDER BY rowid DESC;" | sed 's/^/   /'
bad=$(sqlite3 "file:$SCRUPLE_DB_PATH?mode=ro" -batch \
  "SELECT count(*) FROM iterations WHERE output_hash='$OUTHASH' AND attestation_basis='verified';")
if [ "$bad" != "0" ]; then echo "   FAIL — $bad leaf(s) claim 'verified' against a SOFTWARE-backed surrogate"; rc=1
else echo "   PASS  no leaf claims 'verified'"; fi

echo "   and what the gate MEASURED about its own isolation:"
python3 -c "
import json
r=json.load(open('$RD/result.json'))['steps']['stop']['value']['gateResult']
i=r.get('isolation') or {}
print('   enforcement_present:', i.get('enforcementPresent'))
print('   note:', i.get('note'))
print('   declared placement :', r['assurance']['placement'], '/', r['assurance']['enforcement'])
"

stage "stage 5 — the audit sweep"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --audit || rc=1

stage "control A — swap the model's weights; the fingerprint assertion must go RED"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --break model-swap --expect-fail || rc=1

stage "control B — the same gate with no host adapter; the fingerprints must STOP"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --break no-adapter --expect-fail || rc=1

stage "control C — the same generation around the gate; the enrichment must STOP"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --break bypass-the-gate --expect-fail || rc=1

stage "control D — ComfyUI on 0.0.0.0; the ledger's loopback reading must MOVE"
node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --break upstream-listens-wide --expect-fail || rc=1

stage "control E — the clean run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs comfy-generate --url "$APP_URL" --expect-fail >/dev/null 2>&1; then
  echo "   a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-D4 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED, every mutation caught, all controls fired' || echo 'NOT PASSED')"
exit $rc
