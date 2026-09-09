#!/usr/bin/env bash
# WO-D7 gate. The whole flow, and a named control for every one of its claims.
#
#   stage 0  the sandbox — a key and a baseline for BOTH surfaces, because one
#            app now runs the vault and the ComfyUI gate in the same launch
#   stage 1  the SERVER signs through the surrogate, proved by signing — and
#            the control this work order found: with the DEFAULT certificate
#            embedded, a surrogate signature is INVALID and the signer says
#            ok:true anyway. RED before the fix, GREEN after.
#   stage 2  the control that makes "signed by the surrogate" a measurement:
#            stop the surrogate and the signature must FAIL, not fall back
#   the gate  launch · gate · generate · vault · witness · receipt · C2PA,
#            one app, one launch, and the table
#   stage 4  CONTROL — a leaf id nobody issued must NOT resolve, and a leaf
#            this run made must. Both directions, from the shell
#   stage 5  CONTROL — the database refuses a desktop leaf claiming `verified`,
#            and accepts `stale` on the same copy, so the refusal is the CHECK
#            constraint and not a broken INSERT
#   stage 6  the audit sweep — each mutation reddens exactly what it targets
#   stage 7  control — a passing run must NOT satisfy --expect-fail
#
# Nothing here reads a log line and nothing reads a pixel (docs/DESIGN.md:
# llvmpipe returns a blank frame).
set -uo pipefail
cd "$(dirname "$0")/.."
APP_URL="${SCRUPLE_APP_URL:-http://127.0.0.1:3902}"
export SCRUPLE_APP_URL="$APP_URL"
export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-/mnt/corpus/scruple-council-impl/scruple-scratch.db}"
export SCRUPLE_WITNESS_DB="${SCRUPLE_WITNESS_DB:-/mnt/corpus/scruple-council-impl/witness-scratch.db}"
export SCRUPLE_BDK_ALLOW_DEV="${SCRUPLE_BDK_ALLOW_DEV:-1}"
SURROGATE="${SCRUPLE_CVM_SURROGATE:-http://127.0.0.1:8799}"
WEB="${SCRUPLE_WEB_ROOT:-/data/scruple-web}"
CERTDIR="${D7_CERT_DIR:-$PWD/.run/d7/c2pa-surrogate}"
OCID="${SCRUPLE_C2PA_SURROGATE_OCID:-ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey}"
rc=0
LOGDIR="$PWD/.run/d7"; mkdir -p "$LOGDIR"

# 🔴 The rails, enforced rather than remembered.
case "$APP_URL" in *:5799*|*:3001*) echo "!! $APP_URL is production; refusing"; exit 2;; esac
case "$SURROGATE" in *:5799*|*:3001*) echo "!! $SURROGATE is production; refusing"; exit 2;; esac
case "$SCRUPLE_WITNESS_DB" in */witness.db|*/scruple-witness/*) echo "!! $SCRUPLE_WITNESS_DB is not the scratch witness; refusing"; exit 2;; esac

stage(){ printf '\n════ %s ════\n' "$1"; }
newest(){ ls -dt .run/d2/$1-* 2>/dev/null | head -1; }

stage "stage 0 — the sandbox, for BOTH surfaces"
bash scripts/tsx.sh scripts/d3-sandbox.ts --surface app/comfy || { echo "   comfy sandbox failed"; exit 2; }
bash scripts/tsx.sh scripts/d3-sandbox.ts --surface app/vault || { echo "   vault sandbox failed"; exit 2; }

stage "stage 1 — the server signs through the surrogate, and the cert it embeds is for THAT key"
bash scripts/d7-surrogate-cert.sh || { echo "   could not issue the surrogate cert"; rc=1; }
bash scripts/d7-app-signing.sh || { echo "   the app is not signing through the surrogate"; rc=1; }
# ⚑ THE CONTROL, RED BEFORE THE CHANGE AND GREEN AFTER — both halves produced
# HERE, by signing the same bytes twice with the same key and two different
# certificates. The default certificate belongs to the LOCAL key; the signer
# never checks that the certificate matches the key that signed, so it returns
# success and c2pa.Reader answers `claimSignature.mismatch`.
mkdir -p .run/d7
python3 - <<'PY'
import struct, zlib, pathlib
raw = b''.join(b'\x00' + bytes((11, 22, 33)) * 16 for _ in range(16))
def c(t, d):
    b = t + d
    return struct.pack('>I', len(d)) + b + struct.pack('>I', zlib.crc32(b) & 0xffffffff)
pathlib.Path('.run/d7/cert-control.png').write_bytes(
    b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
    + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b''))
PY
sign_with() { # $1 = cert chain, $2 = output
  python3 - "$1" "$2" <<'PY' | (cd "$WEB/services/c2pa-signer" && SCRUPLE_C2PA_VAULT_KEY_OCID="$OCID" SCRUPLE_C2PA_KMS_ENDPOINT="$SURROGATE" python3 sign.py) 2>/dev/null
import json, sys, os
print(json.dumps({
  "asset_path": os.path.abspath(".run/d7/cert-control.png"),
  "output_path": os.path.abspath(sys.argv[2]),
  "cert_path": sys.argv[1],
  "key_path": "/data/scruple-web/services/c2pa-signer/keys/signer.key",
  "manifest": {"title": "d7 cert control", "format": "image/png", "assertions": []},
  "intent": "CREATE", "digital_source_type": "TRAINED_ALGORITHMIC_MEDIA", "actions": []}))
PY
}
sign_with "$WEB/services/c2pa-signer/keys/signer.pem" .run/d7/control-default-cert.png >/dev/null
sign_with "$CERTDIR/surrogate-chain.pem"             .run/d7/control-surrogate-cert.png >/dev/null
python3 - <<'PY' || rc=1
import json
from c2pa import Reader
def codes(p):
    try:
        with open(p, 'rb') as f:
            return [s['code'] for s in (json.loads(Reader('image/png', f).json()).get('validation_status') or [])]
    except Exception as e:
        return [f'unreadable: {e}']
before = codes('.run/d7/control-default-cert.png')
after  = codes('.run/d7/control-surrogate-cert.png')
print(f"   the DEFAULT certificate, surrogate key : {before}")
print(f"   a certificate FOR the surrogate key    : {after}")
ok = True
if 'claimSignature.mismatch' not in before:
    print('   FAIL  the control is vacuous — the default cert did not produce an invalid signature'); ok = False
if 'claimSignature.mismatch' in after:
    print('   FAIL  the credential this flow produces still does not verify'); ok = False
if 'signingCredential.untrusted' not in after:
    print('   FAIL  a dev root reporting as trusted is worse than one reporting as untrusted'); ok = False
print('   PASS  RED before, GREEN after — and `signingCredential.untrusted` stays, as it must' if ok else '   NOT PASSED')
raise SystemExit(0 if ok else 1)
PY

stage "stage 2 — CONTROL: with the surrogate stopped, the signature must FAIL"
# If it succeeds with the surrogate down, then whatever signed it was not the
# surrogate and "signed by a key this machine cannot reach" is a label.
SPID=$(ss -ltnp 2>/dev/null | awk '/:8799 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)
if [ -z "$SPID" ]; then echo "   FAIL  nothing is listening on :8799"; rc=1; else
  kill "$SPID"
  # ⚑ WAIT FOR THE ANSWER TO STOP, NOT FOR THE PORT TO DISAPPEAR — and then say
  # so out loud. The first version broke out of a bounded loop on `ss` and
  # signed regardless of what it found, so a surrogate that was still up
  # produced a signature and the control read "it signed anyway" when the truth
  # was "the control never ran". An inconclusive control must announce that it
  # is inconclusive; it must never be scored either way.
  DOWN=no
  for _ in $(seq 1 30); do
    curl -s -m 2 -o /dev/null "$SURROGATE/health" || { DOWN=yes; break; }
    sleep 1
  done
  if [ "$DOWN" != "yes" ]; then
    echo "   FAIL  the surrogate is still answering after SIGTERM — this control is INCONCLUSIVE, not passed"; rc=1
  fi
  # The WHOLE output: sign.py writes one JSON object and `tail -c` cut its
  # front off, so a perfectly readable refusal printed as "no JSON at all".
  OUT=$([ "$DOWN" = "yes" ] && sign_with "$CERTDIR/surrogate-chain.pem" .run/d7/control-surrogate-down.png 2>/dev/null)
  echo "   with :8799 down → $(printf '%s' "$OUT" | python3 -c "import sys,json
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])
    print('ok=' + str(d.get('ok')), str(d.get('error'))[:110])
except Exception:
    print('the signer produced no JSON at all')")"
  if [ "$DOWN" = "yes" ]; then
    case "$OUT" in
      *'"ok": true'*) echo "   FAIL  it signed anyway — the surrogate was never the signer"; rc=1;;
      *'"ok": false'*) echo "   PASS  no surrogate, no signature — and no silent fall back to a local key";;
      # Neither answer is not an answer. A signer that produced nothing
      # readable has not demonstrated anything about where its key lives.
      *) echo "   FAIL  the signer produced no verdict at all; the control is inconclusive"; rc=1;;
    esac
  fi
  # ⚑ `setsid --fork`, not `nohup … &`. WITHOUT the fork the restarted
  # surrogate stays a CHILD of this script — and a bash script with a live
  # child sits in do_wait after printing its last line, so the gate reported
  # its verdict and never returned. Found by this gate's own first full run;
  # --fork makes the intermediate exit, so the surrogate is reparented to init
  # and there is nothing left for this shell to wait on.
  ( cd "$WEB/services/cvm-surrogate" && SURROGATE_PORT=8799 \
      setsid --fork nohup /usr/bin/python3 surrogate.py < /dev/null >> "$LOGDIR/surrogate.log" 2>&1 & )
  disown -a 2>/dev/null || true
  for _ in $(seq 1 20); do curl -s -m 2 "$SURROGATE/health" >/dev/null 2>&1 && break; sleep 1; done
  echo "   surrogate back: $(curl -s -m 5 "$SURROGATE/health" | head -c 60)"
fi

stage "the gate — the whole flow, one app, one launch"
echo "\$ node scripts/desktop-run.mjs full-flow"
node scripts/desktop-run.mjs full-flow --url "$APP_URL" --timeout 600000 || rc=1
RUN="$(newest clean)"

stage "stage 4 — CONTROL: an unissued leaf must NOT resolve, and this run's leaves must"
LEAF=$(python3 -c "
import json
r=json.load(open('$RUN/report.json'))
rows=[t for t in r['table'] if t.get('leaf','NONE') not in ('NONE','—','')]
print(rows[0]['leaf'] if rows else '')" 2>/dev/null)
BOGUS=99000000
for pair in "$LEAF:resolvable" "$BOGUS:unresolvable"; do
  id="${pair%%:*}"; want="${pair##*:}"
  got=$(curl -s -m 20 "$APP_URL/api/v2/resolve/$id" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('data') or d).get('resolution'))" 2>/dev/null)
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$APP_URL/api/v2/receipt/$id")
  printf '   leaf %-9s resolve=%-14s receipt=%s   (wanted %s)\n' "$id" "$got" "$code" "$want"
  [ "$got" = "$want" ] || { echo "   FAIL  leaf $id resolved $got"; rc=1; }
done
[ -n "$LEAF" ] || { echo "   FAIL  the run produced no leaf to ask about"; rc=1; }

stage "stage 5 — CONTROL: the database refuses a desktop leaf that claims 'verified'"
# 🔴 On a COPY. The scratch database is never written to by this gate — the
# point is the CHECK constraint, and a constraint is a property of the schema.
python3 - <<'PY' || rc=1
import os, shutil, sqlite3, tempfile
src = os.environ['SCRUPLE_DB_PATH']
tmp = os.path.join(tempfile.mkdtemp(), 'schema-copy.db')
shutil.copy(src, tmp)
db = sqlite3.connect(tmp)
row = db.execute("SELECT * FROM iterations ORDER BY id DESC LIMIT 1").fetchone()
cols = [d[0] for d in db.execute("SELECT * FROM iterations LIMIT 0").description]
# ⚑ A FRESH run_sequence PER ATTEMPT. The first version copied the newest row
# verbatim, so both attempts collided on UNIQUE(project_id, run_sequence) and
# the honest one came back REFUSED for a reason that had nothing to do with the
# constraint under test. A control that fails for the wrong reason is not a
# control, and this gate's first run caught it.
project_id = dict(zip(cols, row))['project_id']
seq = db.execute("SELECT COALESCE(MAX(run_sequence), 0) FROM iterations WHERE project_id = ?",
                 (project_id,)).fetchone()[0]
def attempt(basis, profile):
    global seq
    seq += 1
    vals = dict(zip(cols, row))
    vals['id'] = None
    vals['run_sequence'] = seq
    vals['attestation_basis'] = basis
    vals['attestation_profile'] = profile
    ks = [k for k in cols]
    try:
        db.execute(f"INSERT INTO iterations ({','.join(ks)}) VALUES ({','.join('?' * len(ks))})",
                   [vals[k] for k in ks])
        db.commit()
        return 'ACCEPTED'
    except sqlite3.IntegrityError as e:
        return f'REFUSED ({e})'
forged = attempt('verified', 'desktop')
honest = attempt('stale', 'desktop')
print(f"   desktop + verified : {forged}")
print(f"   desktop + stale    : {honest}")
ok = forged.startswith('REFUSED') and honest == 'ACCEPTED'
print('   PASS  `verified` is unrepresentable on the desktop profile at the DATABASE, and the same INSERT with an honest basis goes through'
      if ok else '   FAIL  the constraint is not doing what the leaf claims it does')
raise SystemExit(0 if ok else 1)
PY

stage "stage 6 — the audit sweep"
node scripts/desktop-run.mjs full-flow --url "$APP_URL" --timeout 600000 --audit || rc=1

stage "stage 7 — control: a passing run must NOT satisfy --expect-fail"
if node scripts/desktop-run.mjs full-flow --url "$APP_URL" --timeout 600000 --expect-fail >/dev/null 2>&1; then
  echo "   a passing run satisfied --expect-fail — the inversion is broken"; rc=1
else
  echo "   PASS  a passing run does not satisfy --expect-fail"
fi

printf '\n════ WO-D7 %s ════\n' "$([ $rc -eq 0 ] && echo 'GATE PASSED — the whole flow, and every control fired' || echo 'NOT PASSED')"
exit $rc
